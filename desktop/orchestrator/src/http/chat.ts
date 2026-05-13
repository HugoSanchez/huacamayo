import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import {
  ChatStore,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type ChatSessionSummary,
} from './chat-store.ts';
import { HermesSessionsClient } from './hermes-sessions.ts';
import { HermesSupervisor, type HermesGatewayConfig } from './hermes-supervisor.ts';
import {
  buildSkillInvocationPrompt,
  extractSlashSkillRequest,
  findSkillBySlug,
} from './skills.ts';
import { HermesCronsClient, type HermesCronJob } from './hermes-crons-client.ts';

type ChatStatus = 'idle' | 'running' | 'error';

interface ActiveChatRequest {
  sessionId: string;
  responseId: string | null;
  gatewayUrl: string;
  startedAt: number;
  close: () => void;
}

class HermesHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'HermesHttpError';
    this.status = status;
    this.body = body;
  }
}

type HermesEventPayload = Record<string, unknown> | null;

let activeRequest: ActiveChatRequest | null = null;
let chatStatus: ChatStatus = 'idle';
let lastError: string | null = null;

export function buildChatRoutes(
  store: ChatStore,
  hermes: HermesSupervisor,
): Route[] {
  return [
    route('GET', '/chat/status', async (_req, res) => {
      const gateway = await hermes.getStatus();
      json(res, 200, {
        status: chatStatus,
        provider: 'hermes',
        hasActiveRequest: activeRequest !== null,
        activeSessionId: activeRequest?.sessionId ?? null,
        lastError,
        sessionCount: store.listSessions().length,
        gateway: {
          url: gateway.baseUrl,
          reachable: gateway.reachable,
          state: gateway.state,
          source: gateway.source,
          launchConfigured: gateway.launchConfigured,
        },
      });
    }),

    route('GET', '/chat/sessions', async (_req, res) => {
      const sessions = await hydrateSessionSummaries(store, hermes);
      json(res, 200, { sessions });
    }),

    route('POST', '/chat/sessions', async (_req, res, _params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? undefined)
        : undefined;
      const session = store.createSession(title);
      json(res, 201, { session });
    }),

    route('GET', '/chat/sessions/:id', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = await hydrateSessionSummary(record, store, hermes);
      json(res, 200, { session });
    }),

    route('GET', '/chat/sessions/:id/messages', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const messages = await hydrateSessionMessages(record, store, hermes);
      json(res, 200, { messages });
    }),

    route('POST', '/chat/sessions/:id/rename', async (_req, res, params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? '').trim()
        : '';
      if (!title) {
        return json(res, 400, { error: 'bad_request', message: 'Missing "title"' });
      }

      const record = store.renameSession(params.id, title);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      const session = await hydrateSessionSummary(record, store, hermes);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/archive', async (_req, res, params) => {
      const record = store.archiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = await hydrateSessionSummary(record, store, hermes);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/unarchive', async (_req, res, params) => {
      const record = store.unarchiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = await hydrateSessionSummary(record, store, hermes);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/messages', async (req, res, params, body) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      const content = typeof (body as { content?: unknown } | null)?.content === 'string'
        ? ((body as { content?: string }).content ?? '').trim()
        : '';
      if (!content) {
        return json(res, 400, { error: 'bad_request', message: 'Missing "content"' });
      }

      if (activeRequest) {
        return json(res, 409, { error: 'conflict', message: 'A chat request is already running' });
      }

      const priorMessageCount = store.getMessages(params.id)?.length ?? 0;
      const isFirstUserMessage = priorMessageCount === 0;

      store.appendMessage(params.id, 'user', content);

      const attached = parseAttached(body);
      let promptForHermes = content;
      if (attached?.kind === 'cron') {
        // Fetch the cron's current state and prepend it as a system block so
        // the agent can reason about — and edit — the job via its `cronjob`
        // tool. If the fetch fails, fall through to the raw user text.
        const cronContext = await buildCronContextPrompt(hermes, attached.id, content)
          .catch(() => null);
        if (cronContext) promptForHermes = cronContext;
      } else {
        const slashRequest = extractSlashSkillRequest(content);
        const skill = slashRequest ? findSkillBySlug(slashRequest.slug) : null;
        if (skill && slashRequest) {
          promptForHermes = buildSkillInvocationPrompt(skill, slashRequest.remainder, params.id);
        }
      }

      const session = await hydrateSessionSummary(record, store, hermes);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      chatStatus = 'running';
      lastError = null;

      try {
        await runHermesMessage({
          session,
          sessionRecord: record,
          userPrompt: promptForHermes,
          isFirstUserMessage,
          res,
          requestBaseUrl: requestBaseUrl(req),
        }, store, hermes);
      } catch (error: unknown) {
        if (isAbortError(error)) {
          sendSSE(res, { type: 'done', reason: 'aborted', session_id: session.id });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          chatStatus = 'error';
          sendSSE(res, { type: 'error', message, session_id: session.id });
        }
      } finally {
        activeRequest = null;
        if (chatStatus === 'running') {
          chatStatus = 'idle';
        }
        res.end();
      }
    }),

    route('POST', '/chat/sessions/:id/cancel', async (_req, res, params) => {
      const session = store.getSessionRecord(params.id);
      if (!session) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      if (!activeRequest || activeRequest.sessionId !== params.id) {
        return json(res, 200, { status: 'no_active_request' });
      }

      activeRequest.close();
      activeRequest = null;
      chatStatus = 'idle';
      json(res, 200, { status: 'stopped' });
    }),
  ];
}

export function buildChatDiagnostics(store: ChatStore): {
  status: ChatStatus;
  lastError: string | null;
  activeRequest: Omit<ActiveChatRequest, 'close'> | null;
  sessionCount: number;
  storePath: string;
} {
  return {
    status: chatStatus,
    lastError,
    activeRequest: activeRequest
      ? {
        sessionId: activeRequest.sessionId,
        responseId: activeRequest.responseId,
        gatewayUrl: activeRequest.gatewayUrl,
        startedAt: activeRequest.startedAt,
      }
      : null,
    sessionCount: store.listSessions().length,
    storePath: store.path,
  };
}

type AttachedContext = { kind: 'cron'; id: string };

function parseAttached(body: unknown): AttachedContext | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).attached;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'cron' && typeof obj.id === 'string' && obj.id.length > 0) {
    return { kind: 'cron', id: obj.id };
  }
  return null;
}

// Mirrors the spirit of buildSkillInvocationPrompt: prepend a system block
// describing the cron's current state so Hermes' agent can reason about it
// and (via its cronjob tool) make changes the user requests in plain text.
async function buildCronContextPrompt(
  hermes: HermesSupervisor,
  cronId: string,
  userText: string,
): Promise<string | null> {
  const config = await hermes.ensureReady();
  const client = new HermesCronsClient(config.baseUrl);
  const cron = await client.get(cronId);
  if (!cron) return null;

  const lines = formatCronContextLines(cron);
  const trimmed = userText.trim();
  const sections = [
    `[SYSTEM: The user has attached the cron job "${cron.name}" (id: ${cron.id}) for review or editing. Its current state is below — to make changes, call the \`cronjob\` tool with action="update" (or "pause"/"resume"/"remove") and job_id="${cron.id}".]`,
    '',
    ...lines,
  ];
  if (trimmed.length > 0) {
    sections.push('', `User instruction: ${trimmed}`);
  } else {
    sections.push('', 'No additional instruction was provided. Acknowledge the cron and wait for the user.');
  }
  return sections.join('\n');
}

function formatCronContextLines(cron: HermesCronJob): string[] {
  const lines: string[] = [
    `- Name: ${cron.name}`,
    `- Schedule: ${cron.schedule_display ?? JSON.stringify(cron.schedule)}`,
    `- State: ${cron.state}${cron.enabled ? '' : ' (disabled)'}`,
  ];
  if (cron.next_run_at) lines.push(`- Next run: ${cron.next_run_at}`);
  if (cron.last_run_at) {
    const status = cron.last_status ? ` (${cron.last_status})` : '';
    lines.push(`- Last run: ${cron.last_run_at}${status}`);
  }
  if (cron.last_error) lines.push(`- Last error: ${cron.last_error}`);
  if (Array.isArray(cron.skills) && cron.skills.length > 0) {
    lines.push(`- Skills loaded on each run: ${cron.skills.join(', ')}`);
  }
  if (cron.deliver) lines.push(`- Deliver: ${cron.deliver}`);
  lines.push('');
  lines.push('Prompt:');
  lines.push(cron.prompt);
  return lines;
}

async function hydrateSessionSummaries(store: ChatStore, hermes: HermesSupervisor): Promise<ChatSessionSummary[]> {
  const records = store.listSessionRecords();
  const client = await maybeCreateHermesSessionsClient(records, hermes);
  return Promise.all(records.map((record) => hydrateSessionSummaryRecord(record, store, client)));
}

async function hydrateSessionSummary(
  record: ChatSessionRecord,
  store: ChatStore,
  hermes: HermesSupervisor,
): Promise<ChatSessionSummary> {
  const client = await maybeCreateHermesSessionsClient([record], hermes);
  return hydrateSessionSummaryRecord(record, store, client);
}

async function hydrateSessionMessages(
  record: ChatSessionRecord,
  store: ChatStore,
  hermes: HermesSupervisor,
): Promise<ChatMessageRecord[]> {
  const client = await maybeCreateHermesSessionsClient([record], hermes);
  return loadSessionMessages(record, store, client);
}

async function maybeCreateHermesSessionsClient(
  records: ChatSessionRecord[],
  hermes: HermesSupervisor,
): Promise<HermesSessionsClient | null> {
  if (!records.some((record) => record.hermesSessionId)) return null;

  try {
    const config = await hermes.ensureReady();
    return new HermesSessionsClient(config.baseUrl);
  } catch {
    return null;
  }
}

async function hydrateSessionSummaryRecord(
  record: ChatSessionRecord,
  store: ChatStore,
  client: HermesSessionsClient | null,
): Promise<ChatSessionSummary> {
  const [detail, messages] = await Promise.all([
    loadHermesSessionDetail(record, client),
    loadSessionMessages(record, store, client),
  ]);
  const lastMessage = messages[messages.length - 1];
  const updatedAt = [
    record.updatedAt,
    lastMessage?.createdAt ?? null,
    timestampToIso(detail?.last_active) ?? null,
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? record.updatedAt;

  return {
    id: record.id,
    title: resolveSessionTitle(record, detail),
    createdAt: record.createdAt,
    updatedAt,
    archivedAt: record.archivedAt,
    messageCount: messages.length,
    lastMessagePreview: lastMessage ? preview(lastMessage.content) : null,
  };
}

async function loadSessionMessages(
  record: ChatSessionRecord,
  store: ChatStore,
  _client: HermesSessionsClient | null,
): Promise<ChatMessageRecord[]> {
  return store.getMessages(record.id) ?? [];
}

async function loadHermesVisibleMessages(
  record: ChatSessionRecord,
  client: HermesSessionsClient | null,
): Promise<ChatMessageRecord[]> {
  if (!record.hermesSessionId || !client) return [];

  try {
    const messages = await client.getSessionMessages(record.hermesSessionId);
    if (!messages) return [];

    return messages
      .filter((message) =>
        (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && message.content.trim().length > 0)
      .map((message) => ({
        id: `hermes:${record.hermesSessionId}:${message.id}`,
        sessionId: record.id,
        role: message.role as 'user' | 'assistant',
        content: message.content ?? '',
        createdAt: timestampToIso(message.timestamp) ?? new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

async function loadHermesSessionDetail(
  record: ChatSessionRecord,
  client: HermesSessionsClient | null,
): Promise<{ title?: string | null; last_active?: number } | null> {
  if (!record.hermesSessionId || !client) return null;

  try {
    return await client.getSession(record.hermesSessionId);
  } catch {
    return null;
  }
}

function resolveSessionTitle(
  record: ChatSessionRecord,
  detail: { title?: string | null } | null,
): string {
  const hermesTitle = typeof detail?.title === 'string' ? detail.title.trim() : '';
  return hermesTitle || record.title;
}

async function runHermesMessage(
  opts: {
    session: ChatSessionSummary;
    sessionRecord: ChatSessionRecord;
    userPrompt: string;
    isFirstUserMessage: boolean;
    res: ServerResponse;
    requestBaseUrl: string;
  },
  store: ChatStore,
  hermes: HermesSupervisor,
): Promise<void> {
  const controller = new AbortController();
  const runtime = await hermes.getStatus(500);

  if (runtime.state !== 'ready') {
    sendSSE(opts.res, {
      type: 'status',
      provider: 'hermes',
      session_id: opts.session.id,
      message: 'Starting Hermes',
    });
  }

  const config = await hermes.ensureReady(controller.signal);
  const client = new HermesSessionsClient(config.baseUrl);

  activeRequest = {
    sessionId: opts.session.id,
    responseId: null,
    gatewayUrl: config.baseUrl,
    startedAt: Date.now(),
    close: () => controller.abort(),
  };

  let streamedText = '';
  let finalText = '';
  let linkedHermesSessionId = opts.sessionRecord.hermesSessionId;

  const handleEvent = (eventName: string, data: HermesEventPayload) => {
    if (eventName === 'response.created') {
      const responseId = extractResponseId(data);
      if (responseId && activeRequest) {
        activeRequest.responseId = responseId;
      }
      return;
    }

    if (eventName === 'response.output_text.delta') {
      const delta = typeof data?.delta === 'string' ? data.delta : '';
      if (!delta) return;
      streamedText += delta;
      sendSSE(opts.res, {
        type: 'content_block_delta',
        session_id: opts.session.id,
        delta: { text: delta },
      });
      return;
    }

    if (eventName === 'response.output_text.done') {
      const text = typeof data?.text === 'string' ? data.text : '';
      if (text) {
        finalText = text;
      }
      return;
    }

    if (eventName === 'response.output_item.added') {
      const item = asRecord(data?.item);
      if (!item) return;

      if (item.type === 'function_call') {
        const toolName = typeof item.name === 'string' ? item.name : 'tool';
        sendSSE(opts.res, {
          type: 'assistant',
          session_id: opts.session.id,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: typeof item.call_id === 'string' ? item.call_id : undefined,
              name: toolName,
              input: parseJsonMaybe(item.arguments),
            }],
          },
        });
        return;
      }

      if (item.type === 'function_call_output') {
        sendSSE(opts.res, {
          type: 'user',
          session_id: opts.session.id,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: typeof item.call_id === 'string' ? item.call_id : undefined,
              content: parseJsonMaybe(item.output),
            }],
          },
        });
      }
      return;
    }

    if (eventName === 'response.completed') {
      finalText = extractFinalResponseText(data) || finalText || streamedText;
      return;
    }

    if (eventName === 'response.failed') {
      const message = extractResponseError(data) || 'Hermes response failed';
      throw new Error(message);
    }
  };

  try {
    await streamHermesConversation(config, {
      conversation: opts.session.id,
      userPrompt: opts.userPrompt,
      conversationHistory: null,
      signal: controller.signal,
      onSessionId: (sessionId) => {
        linkedHermesSessionId = sessionId;
      },
      onEvent: handleEvent,
    });
  } catch (error: unknown) {
    if (shouldRetryWithoutCursor(error) && linkedHermesSessionId) {
      sendSSE(opts.res, {
        type: 'status',
        provider: 'hermes',
        session_id: opts.session.id,
        message: 'Recovering chat context',
      });

      streamedText = '';
      finalText = '';
      const recoveryMessages = await loadHermesVisibleMessages({
        ...opts.sessionRecord,
        hermesSessionId: linkedHermesSessionId,
      }, client);

      await streamHermesConversation(config, {
        conversation: opts.session.id,
        userPrompt: opts.userPrompt,
        conversationHistory: recoveryMessages,
        signal: controller.signal,
        onSessionId: (sessionId) => {
          linkedHermesSessionId = sessionId;
        },
        onEvent: handleEvent,
      });
    } else {
      throw error;
    }
  }

  if (linkedHermesSessionId && linkedHermesSessionId !== opts.sessionRecord.hermesSessionId) {
    store.linkHermesSession(opts.session.id, linkedHermesSessionId);
  }

  const assistantText = finalText || streamedText;
  if (assistantText) {
    store.appendMessage(opts.session.id, 'assistant', assistantText);
  }

  store.touchSession(opts.session.id);

  if (opts.isFirstUserMessage && assistantText) {
    const currentTitle = store.getSessionRecord(opts.session.id)?.title ?? '';
    if (currentTitle === DEFAULT_SESSION_TITLE) {
      const title = await generateSessionTitle(config, opts.userPrompt, assistantText)
        .catch(() => null);
      if (title) {
        store.renameSession(opts.session.id, title);
        sendSSE(opts.res, { type: 'session_title', session_id: opts.session.id, title });
      }
    }
  }

  sendSSE(opts.res, { type: 'done', session_id: opts.session.id });
}

const DEFAULT_SESSION_TITLE = 'New chat';
const TITLE_GEN_TIMEOUT_MS = 8_000;
const TITLE_PROMPT_TEMPLATE = (userPrompt: string, assistantText: string) =>
  `Generate a concise title (4-8 words) summarizing this conversation. Respond with ONLY the title — no quotes, no trailing punctuation, no "Title:" prefix.\n\nUser: ${userPrompt}\nAssistant: ${assistantText}`;

async function generateSessionTitle(
  config: HermesGatewayConfig,
  userPrompt: string,
  assistantText: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_GEN_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: TITLE_PROMPT_TEMPLATE(userPrompt, assistantText),
        truncation: 'auto',
        stream: false,
        store: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const raw = extractFinalResponseText({ response: data });
    return sanitizeGeneratedTitle(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeGeneratedTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(/^["'`“”‘’\s]+|["'`“”‘’\s.!?]+$/g, '').trim();
  if (!stripped) return null;
  const words = stripped.split(' ').filter(Boolean).slice(0, 8);
  const title = words.join(' ');
  return title.length > 0 ? title.slice(0, 80) : null;
}

async function streamHermesConversation(
  config: HermesGatewayConfig,
  opts: {
    conversation: string;
    userPrompt: string;
    conversationHistory: ChatMessageRecord[] | null;
    signal: AbortSignal;
    onSessionId: (sessionId: string) => void;
    onEvent: (eventName: string, data: HermesEventPayload) => void;
  },
): Promise<void> {
  const payload = buildHermesRequestBody(opts.conversation, opts.userPrompt, opts.conversationHistory);
  await streamHermesResponse(config, payload, opts.signal, opts.onSessionId, opts.onEvent);
}

function buildHermesRequestBody(
  conversation: string,
  userPrompt: string,
  conversationHistory: ChatMessageRecord[] | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: userPrompt,
    conversation,
    truncation: 'auto',
    stream: true,
    store: true,
  };

  if (conversationHistory && conversationHistory.length > 0) {
    body.conversation_history = conversationHistory.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  return body;
}

async function streamHermesResponse(
  config: HermesGatewayConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onSessionId: (sessionId: string) => void,
  onEvent: (eventName: string, data: HermesEventPayload) => void,
): Promise<void> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs);

  try {
    const res = await fetch(`${config.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: anySignal([signal, timeoutController.signal]),
    });

    if (!res.ok || !res.body) {
      const responseBody = await safeReadBody(res);
      throw new HermesHttpError(
        res.status,
        responseBody,
        `Hermes response stream failed (HTTP ${res.status})${responseBody ? `: ${responseBody}` : ''}`,
      );
    }

    const hermesSessionId = res.headers.get('x-hermes-session-id');
    if (hermesSessionId) {
      onSessionId(hermesSessionId);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const parsed = parseSseFrame(frame);
        if (!parsed) continue;
        onEvent(parsed.event, parsed.data);
      }
    }

    if (buffer.trim().length > 0) {
      const parsed = parseSseFrame(buffer);
      if (parsed) {
        onEvent(parsed.event, parsed.data);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseFrame(frame: string): { event: string; data: HermesEventPayload } | null {
  const lines = frame
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines.every((line) => line.startsWith(':'))) {
    return null;
  }

  let eventName = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim() || eventName;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return { event: eventName, data: null };
  }

  try {
    const parsed = JSON.parse(dataLines.join('\n'));
    return parsed && typeof parsed === 'object'
      ? { event: eventName, data: parsed as Record<string, unknown> }
      : { event: eventName, data: null };
  } catch {
    return { event: eventName, data: null };
  }
}

function extractResponseId(data: HermesEventPayload): string | null {
  const response = asRecord(data?.response);
  const responseId = response?.id;
  return typeof responseId === 'string' && responseId.length > 0 ? responseId : null;
}

function extractFinalResponseText(data: HermesEventPayload): string {
  const response = asRecord(data?.response);
  const output = Array.isArray(response?.output) ? response.output : [];

  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = asRecord(output[index]);
    if (!item || item.type !== 'message' || item.role !== 'assistant') continue;
    return extractOutputText(item.content);
  }

  return '';
}

function extractResponseError(data: HermesEventPayload): string {
  const response = asRecord(data?.response);
  const error = asRecord(response?.error);
  const message = error?.message;
  return typeof message === 'string' ? message : '';
}

function extractOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'output_text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .filter(Boolean)
    .join('');
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shouldRetryWithoutCursor(error: unknown): boolean {
  if (!(error instanceof HermesHttpError)) return false;
  if (error.status !== 404) return false;
  return /previous response not found/i.test(error.body);
}

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || '127.0.0.1';
  return `http://${host}`;
}

function sendSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort/i.test(error.message);
  }
  return false;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const activeSignals = signals.filter(Boolean);

  if (activeSignals.some((activeSignal) => activeSignal.aborted)) {
    controller.abort();
    return controller.signal;
  }

  const onAbort = () => {
    controller.abort();
    for (const activeSignal of activeSignals) {
      activeSignal.removeEventListener('abort', onAbort);
    }
  };

  for (const activeSignal of activeSignals) {
    activeSignal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 120)}...`;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

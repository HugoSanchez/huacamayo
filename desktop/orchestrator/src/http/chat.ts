import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import {
  ChatStore,
  type ChatMessageRecord,
  type ChatSessionRecord,
  type ChatSessionSummary,
} from './chat-store.ts';
import { applyDraftResolutions } from './draft-resolutions.ts';
import { HermesSupervisor, hermesGatewayAuthHeaders, type HermesGatewayConfig } from './hermes-supervisor.ts';
import { readHermesChatMessages } from './hermes-history.ts';
import {
  buildSkillInvocationPrompt,
  extractSlashSkillRequest,
  findSkillBySlug,
} from './skills.ts';
import { HermesCronsClient, type HermesCronJob } from './hermes-crons-client.ts';
import { type MemoryExtractionScheduler } from './memory-extraction.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';

type ChatStatus = 'idle' | 'running';

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

// Per-session streams: each session can have at most one in-flight chat
// request, but different sessions stream independently. Hermes handles
// concurrent /v1/responses for different `conversation` ids (verified by the
// per-session-streams spike).
const activeRequests = new Map<string, ActiveChatRequest>();

export function buildChatRoutes(
  store: ChatStore,
  hermes: HermesSupervisor,
  managedBackend: ManagedBackendClient,
  memoryExtraction?: MemoryExtractionScheduler,
): Route[] {
  return [
    route('GET', '/chat/status', async (_req, res) => {
      const gateway = await hermes.getStatus();
      const activeSessionIds = Array.from(activeRequests.keys());
      json(res, 200, {
        status: activeRequests.size > 0 ? 'running' : 'idle',
        provider: 'hermes',
        hasActiveRequest: activeRequests.size > 0,
        activeSessionIds,
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
      const sessions = hydrateSessionSummaries(store);
      json(res, 200, { sessions });
    }),

    route('POST', '/chat/sessions', async (_req, res, _params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? undefined)
        : undefined;
      const session = store.createSession(title);
      managedBackend.recordAnalyticsEvent({ eventType: 'session_created', sessionId: session.id });
      json(res, 201, { session });
    }),

    route('GET', '/chat/sessions/:id', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('GET', '/chat/sessions/:id/messages', async (_req, res, params) => {
      const record = store.getSessionRecord(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const messages = hydrateSessionMessages(record, store, hermes);
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

      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/archive', async (_req, res, params) => {
      const record = store.archiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
      json(res, 200, { session });
    }),

    route('POST', '/chat/sessions/:id/unarchive', async (_req, res, params) => {
      const record = store.unarchiveSession(params.id);
      if (!record) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      const session = hydrateSessionSummary(record, store);
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

      // Per-session: block only a second concurrent request for the *same*
      // session. Streams against other sessions run in parallel.
      if (activeRequests.has(params.id)) {
        return json(res, 409, {
          error: 'conflict',
          message: 'A chat request is already running for this session',
        });
      }

      const priorMessageCount = store.getMessages(params.id)?.length ?? 0;
      const isFirstUserMessage = priorMessageCount === 0;

      store.appendMessage(params.id, 'user', content);
      managedBackend.recordAnalyticsEvent({ eventType: 'message_sent', sessionId: params.id });

      const attached = parseAttached(body);
      const reasoningEffort = parseReasoningEffort(body);
      const model = parseChatModel(body);
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

      const session = hydrateSessionSummary(record, store);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        await runHermesMessage({
          session,
          sessionRecord: record,
          userPrompt: promptForHermes,
          isFirstUserMessage,
          reasoningEffort,
          model,
          res,
          requestBaseUrl: requestBaseUrl(req),
        }, store, hermes, managedBackend, memoryExtraction);
      } catch (error: unknown) {
        if (isAbortError(error)) {
          sendSSE(res, { type: 'done', reason: 'aborted', session_id: session.id });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          sendSSE(res, { type: 'error', message, session_id: session.id });
        }
      } finally {
        activeRequests.delete(session.id);
        res.end();
      }
    }),

    route('POST', '/chat/sessions/:id/cancel', async (_req, res, params) => {
      const session = store.getSessionRecord(params.id);
      if (!session) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

      const active = activeRequests.get(params.id);
      if (!active) {
        return json(res, 200, { status: 'no_active_request' });
      }

      active.close();
      activeRequests.delete(params.id);
      json(res, 200, { status: 'stopped' });
    }),
  ];
}

export function buildChatDiagnostics(
  store: ChatStore,
  memoryExtraction?: MemoryExtractionScheduler,
): {
  status: ChatStatus;
  activeRequests: Array<Omit<ActiveChatRequest, 'close'>>;
  sessionCount: number;
  storePath: string;
  memoryExtraction?: ReturnType<MemoryExtractionScheduler['diagnostics']>;
} {
  return {
    status: activeRequests.size > 0 ? 'running' : 'idle',
    activeRequests: Array.from(activeRequests.values()).map((request) => ({
      sessionId: request.sessionId,
      responseId: request.responseId,
      gatewayUrl: request.gatewayUrl,
      startedAt: request.startedAt,
    })),
    sessionCount: store.listSessions().length,
    storePath: store.path,
    ...(memoryExtraction ? { memoryExtraction: memoryExtraction.diagnostics() } : {}),
  };
}

type AttachedContext = { kind: 'cron'; id: string };

// Reasoning-effort levels Hermes accepts (see hermes_constants.VALID_REASONING_EFFORTS).
// The chat-input selector sends one of these per message; anything else falls
// back to the gateway's config.yaml default.
const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
type ReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

function parseReasoningEffort(body: unknown): ReasoningEffort | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).reasoningEffort
    : undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : null;
}

// Codex models the chat-input model selector may pick. Allowlisted so a stray
// client value can't ask the gateway to load an unauthenticated model; absent
// values let the gateway use its config.yaml default.
const VALID_CHAT_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
type ChatModel = (typeof VALID_CHAT_MODELS)[number];

function parseChatModel(body: unknown): ChatModel | null {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).model
    : undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (VALID_CHAT_MODELS as readonly string[]).includes(value)
    ? (value as ChatModel)
    : null;
}

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
  const client = new HermesCronsClient(config.baseUrl, config.apiKey ?? undefined);
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

function hydrateSessionSummaries(store: ChatStore): ChatSessionSummary[] {
  return store.listSessionRecords().map((record) => hydrateSessionSummaryRecord(record, store));
}

function hydrateSessionSummary(record: ChatSessionRecord, store: ChatStore): ChatSessionSummary {
  return hydrateSessionSummaryRecord(record, store);
}

function hydrateSessionMessages(
  record: ChatSessionRecord,
  store: ChatStore,
  hermes: HermesSupervisor,
): ChatMessageRecord[] {
  const localMessages = store.getMessages(record.id) ?? [];
  const hermesMessages = readHermesChatMessages({
    hermesHome: hermes.hermesHome,
    hermesSessionId: record.hermesSessionId,
    versoSessionId: record.id,
    localMessages,
  });
  const messages = hermesMessages ?? addLocalResponseTimings(localMessages);
  return applyDraftResolutions(messages, store.listDraftResolutions(record.id));
}

function addLocalResponseTimings(messages: ChatMessageRecord[]): ChatMessageRecord[] {
  let lastUserStartedAt: number | undefined;

  return messages.map((message) => {
    if (message.role === 'user') {
      lastUserStartedAt = Date.parse(message.createdAt);
      if (!Number.isFinite(lastUserStartedAt)) {
        lastUserStartedAt = undefined;
      }
      return message;
    }

    const endedAt = Date.parse(message.createdAt);
    return {
      ...message,
      startedAt: message.startedAt ?? lastUserStartedAt,
      endedAt: message.endedAt ?? (Number.isFinite(endedAt) ? endedAt : undefined),
    };
  });
}

function hydrateSessionSummaryRecord(
  record: ChatSessionRecord,
  store: ChatStore,
): ChatSessionSummary {
  const messages = store.getMessages(record.id) ?? [];
  const lastMessage = messages[messages.length - 1];
  const updatedAt = [
    record.updatedAt,
    lastMessage?.createdAt ?? null,
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? record.updatedAt;

  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt,
    archivedAt: record.archivedAt,
    messageCount: messages.length,
    lastMessagePreview: lastMessage ? preview(lastMessage.content) : null,
  };
}

async function runHermesMessage(
  opts: {
    session: ChatSessionSummary;
    sessionRecord: ChatSessionRecord;
    userPrompt: string;
    isFirstUserMessage: boolean;
    reasoningEffort?: ReasoningEffort | null;
    model?: ChatModel | null;
    res: ServerResponse;
    requestBaseUrl: string;
  },
  store: ChatStore,
  hermes: HermesSupervisor,
  managedBackend: ManagedBackendClient,
  memoryExtraction?: MemoryExtractionScheduler,
): Promise<void> {
  let toolCallCount = 0;
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

  const activeRequest: ActiveChatRequest = {
    sessionId: opts.session.id,
    responseId: null,
    gatewayUrl: config.baseUrl,
    startedAt: Date.now(),
    close: () => controller.abort(),
  };
  activeRequests.set(opts.session.id, activeRequest);

  let streamedText = '';
  let finalText = '';
  let linkedHermesSessionId = opts.sessionRecord.hermesSessionId;

  const handleEvent = (eventName: string, data: HermesEventPayload) => {
    if (eventName === 'response.created') {
      const responseId = extractResponseId(data);
      if (responseId) {
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

    if (isReasoningDeltaEvent(eventName)) {
      const delta = extractReasoningDelta(data);
      if (!delta) return;
      sendSSE(opts.res, {
        type: 'reasoning_delta',
        session_id: opts.session.id,
        delta: { text: delta },
      });
      return;
    }

    if (eventName === 'response.output_item.added') {
      const item = asRecord(data?.item);
      if (!item) return;

      if (item.type === 'function_call') {
        toolCallCount += 1;
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
      reasoningEffort: opts.reasoningEffort ?? null,
      model: opts.model ?? null,
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
      // Hermes evicted the previous_response_id from its LRU. Rebuild
      // context from our durable copy in `local_messages` and retry.
      const recoveryMessages = store.getMessages(opts.session.id) ?? [];

      await streamHermesConversation(config, {
        conversation: opts.session.id,
        userPrompt: opts.userPrompt,
        conversationHistory: recoveryMessages,
        reasoningEffort: opts.reasoningEffort ?? null,
        model: opts.model ?? null,
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
  const assistantReasoning = linkedHermesSessionId && assistantText
    ? readLatestAssistantReasoning({
      hermes,
      hermesSessionId: linkedHermesSessionId,
      versoSessionId: opts.session.id,
      localMessages: store.getMessages(opts.session.id) ?? [],
      assistantText,
    })
    : null;
  if (assistantReasoning) {
    sendSSE(opts.res, {
      type: 'reasoning',
      session_id: opts.session.id,
      reasoning: assistantReasoning,
    });
  }

  if (assistantText) {
    store.appendMessage(opts.session.id, 'assistant', assistantText);
  }

  store.touchSession(opts.session.id);
  memoryExtraction?.markPending(opts.session.id);

  managedBackend.recordAnalyticsEvent({
    eventType: 'message_completed',
    sessionId: opts.session.id,
    toolCallCount,
  });

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

function readLatestAssistantReasoning(opts: {
  hermes: HermesSupervisor;
  hermesSessionId: string;
  versoSessionId: string;
  localMessages: ChatMessageRecord[];
  assistantText: string;
}): string | null {
  const messages = readHermesChatMessages({
    hermesHome: opts.hermes.hermesHome,
    hermesSessionId: opts.hermesSessionId,
    versoSessionId: opts.versoSessionId,
    localMessages: opts.localMessages,
  });
  if (!messages) return null;

  const expectedText = opts.assistantText.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (expectedText && message.content.trim() !== expectedText) continue;
    const reasoning = message.reasoning?.trim();
    return reasoning && reasoning.length > 0 ? reasoning : null;
  }

  return null;
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
      headers: { 'Content-Type': 'application/json', ...hermesGatewayAuthHeaders(config) },
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
    reasoningEffort?: ReasoningEffort | null;
    model?: ChatModel | null;
    signal: AbortSignal;
    onSessionId: (sessionId: string) => void;
    onEvent: (eventName: string, data: HermesEventPayload) => void;
  },
): Promise<void> {
  const payload = buildHermesRequestBody(
    opts.conversation,
    opts.userPrompt,
    opts.conversationHistory,
    opts.reasoningEffort ?? null,
    opts.model ?? null,
  );
  await streamHermesResponse(config, payload, opts.signal, opts.onSessionId, opts.onEvent);
}

function buildHermesRequestBody(
  conversation: string,
  userPrompt: string,
  conversationHistory: ChatMessageRecord[] | null,
  reasoningEffort: ReasoningEffort | null = null,
  model: ChatModel | null = null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    input: userPrompt,
    conversation,
    truncation: 'auto',
    stream: true,
    store: true,
  };

  // OpenAI Responses native fields. The gateway (via the Verso request-overrides
  // patch) reads `reasoning.effort` and `model` per request and overrides
  // config.yaml for that turn.
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }
  if (model) {
    body.model = model;
  }

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
  const res = await fetch(`${config.baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...hermesGatewayAuthHeaders(config),
    },
    body: JSON.stringify(body),
    signal,
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

function isReasoningDeltaEvent(eventName: string): boolean {
  return eventName === 'hermes.reasoning.delta'
    || eventName === 'response.reasoning_text.delta'
    || eventName === 'response.reasoning_summary_text.delta';
}

function extractReasoningDelta(data: HermesEventPayload): string {
  const delta = data?.delta;
  if (typeof delta === 'string') return delta;
  const text = data?.text;
  if (typeof text === 'string') return text;
  const nestedText = asRecord(delta)?.text;
  return typeof nestedText === 'string' ? nestedText : '';
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


function preview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 120)}...`;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

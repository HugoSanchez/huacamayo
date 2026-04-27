import type { ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import {
  ChatStore,
  type ChatMessageRecord,
  type ChatSessionSummary,
} from './chat-store.ts';
import { HermesSupervisor, type HermesGatewayConfig } from './hermes-supervisor.ts';

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

let activeRequest: ActiveChatRequest | null = null;
let chatStatus: ChatStatus = 'idle';
let lastError: string | null = null;

export function buildChatRoutes(store: ChatStore, hermes: HermesSupervisor): Route[] {
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
      json(res, 200, { sessions: store.listSessions() });
    }),

    route('POST', '/chat/sessions', async (_req, res, _params, body) => {
      const title = typeof (body as { title?: unknown } | null)?.title === 'string'
        ? ((body as { title?: string }).title ?? undefined)
        : undefined;
      const session = store.createSession(title);
      json(res, 201, { session });
    }),

    route('GET', '/chat/sessions/:id', async (_req, res, params) => {
      const session = store.getSession(params.id);
      if (!session) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      json(res, 200, { session });
    }),

    route('GET', '/chat/sessions/:id/messages', async (_req, res, params) => {
      const messages = store.getMessages(params.id);
      if (!messages) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }
      json(res, 200, { messages });
    }),

    route('POST', '/chat/sessions/:id/messages', async (_req, res, params, body) => {
      const session = store.getSession(params.id);
      if (!session) {
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

      const priorMessages = store.getMessages(session.id) ?? [];
      const userMessage = store.appendMessage(session.id, 'user', content);
      if (!userMessage) {
        return json(res, 404, { error: 'not_found', message: `Unknown session: ${params.id}` });
      }

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
          priorMessages,
          userPrompt: content,
          res,
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
      const session = store.getSession(params.id);
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

async function runHermesMessage(
  opts: {
    session: ChatSessionSummary;
    priorMessages: ChatMessageRecord[];
    userPrompt: string;
    res: ServerResponse;
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
  const previousResponseId = store.getLastResponseId(opts.session.id);

  activeRequest = {
    sessionId: opts.session.id,
    responseId: previousResponseId,
    gatewayUrl: config.baseUrl,
    startedAt: Date.now(),
    close: () => controller.abort(),
  };

  let streamedText = '';
  let finalText = '';
  let completedResponseId: string | null = null;

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
        sendSSE(opts.res, {
          type: 'assistant',
          session_id: opts.session.id,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: typeof item.call_id === 'string' ? item.call_id : undefined,
              name: typeof item.name === 'string' ? item.name : 'tool',
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
              content: Array.isArray(item.output) ? item.output : [],
            }],
          },
        });
      }
      return;
    }

    if (eventName === 'response.completed') {
      completedResponseId = extractResponseId(data);
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
      userPrompt: opts.userPrompt,
      priorMessages: opts.priorMessages,
      previousResponseId,
      signal: controller.signal,
      onEvent: handleEvent,
    });
  } catch (error: unknown) {
    if (shouldRetryWithoutCursor(error, previousResponseId)) {
      store.setLastResponseId(opts.session.id, null);
      if (activeRequest) {
        activeRequest.responseId = null;
      }
      sendSSE(opts.res, {
        type: 'status',
        provider: 'hermes',
        session_id: opts.session.id,
        message: 'Recovering chat context',
      });
      streamedText = '';
      finalText = '';
      completedResponseId = null;
      await streamHermesConversation(config, {
        userPrompt: opts.userPrompt,
        priorMessages: opts.priorMessages,
        previousResponseId: null,
        signal: controller.signal,
        onEvent: handleEvent,
      });
    } else {
      throw error;
    }
  }

  const assistantText = finalText || streamedText;
  if (assistantText.trim().length > 0) {
    store.appendMessage(opts.session.id, 'assistant', assistantText);
  }
  if (completedResponseId) {
    store.setLastResponseId(opts.session.id, completedResponseId);
  }

  sendSSE(opts.res, { type: 'done', session_id: opts.session.id });
}

async function streamHermesConversation(
  config: HermesGatewayConfig,
  opts: {
    userPrompt: string;
    priorMessages: ChatMessageRecord[];
    previousResponseId: string | null;
    signal: AbortSignal;
    onEvent: (eventName: string, data: HermesEventPayload) => void;
  },
): Promise<void> {
  const payload = buildHermesRequestBody(opts.priorMessages, opts.userPrompt, opts.previousResponseId);
  await streamHermesResponse(config, payload, opts.signal, opts.onEvent);
}

function buildHermesRequestBody(
  priorMessages: ChatMessageRecord[],
  userPrompt: string,
  previousResponseId: string | null,
): Record<string, unknown> {
  if (previousResponseId) {
    return {
      input: userPrompt,
      previous_response_id: previousResponseId,
      stream: true,
      store: true,
    };
  }

  if (priorMessages.length > 0) {
    return {
      input: userPrompt,
      conversation_history: priorMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      truncation: 'auto',
      stream: true,
      store: true,
    };
  }

  return {
    input: userPrompt,
    stream: true,
    store: true,
  };
}

async function streamHermesResponse(
  config: HermesGatewayConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
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

type HermesEventPayload = Record<string, unknown> | null;

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

function shouldRetryWithoutCursor(error: unknown, previousResponseId: string | null): boolean {
  if (!previousResponseId) return false;
  if (!(error instanceof HermesHttpError)) return false;
  if (error.status !== 404) return false;
  return /previous response not found/i.test(error.body);
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

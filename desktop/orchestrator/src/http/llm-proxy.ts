import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';

/**
 * Local OpenAI-compatible proxy that lets a local agent (Hermes) speak
 * `/v1/chat/completions` against the orchestrator without ever seeing the
 * managed backend session token. The orchestrator strips whatever
 * Authorization header arrives, attaches the in-memory bearer token, and pipes
 * the upstream SSE bytes back unchanged.
 *
 * Mounted at POST /llm/v1/chat/completions so an OpenAI client configured with
 * base_url=http://127.0.0.1:<port>/llm/v1 lands on it directly.
 */
export function buildLlmProxyRoutes(managedBackend: ManagedBackendClient): Route[] {
  return [
    route('POST', '/llm/v1/chat/completions', async (req, res, _params, body) => {
      await proxyChatCompletion(managedBackend, req, res, body);
    }),
    route('POST', '/llm/v1/responses', async (req, res, _params, body) => {
      await proxyResponses(managedBackend, req, res, body);
    }),
  ];
}

async function proxyChatCompletion(
  managedBackend: ManagedBackendClient,
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const session = managedBackend.getStoredSession();
  if (!session) {
    json(res, 401, {
      error: { code: 'missing_session', message: 'No managed session loaded in the orchestrator.' },
    });
    return;
  }

  if (isExpired(session.expiresAt)) {
    json(res, 401, {
      error: { code: 'expired_session', message: 'Managed session has expired locally.' },
    });
    return;
  }

  if (!body || typeof body !== 'object') {
    json(res, 400, {
      error: { code: 'bad_request', message: 'Body must be a JSON object.' },
    });
    return;
  }

  let upstream: Response;
  try {
    upstream = await managedBackend.forwardChatCompletion(body as Record<string, unknown>);
  } catch (error) {
    const detailed = describeFetchFailure(error, `${managedBackend.backendBaseUrl}/v1/chat/completions`);
    console.warn(`[llm-proxy] chat/completions ${detailed}`);
    json(res, 502, {
      error: { code: 'backend_unreachable', message: detailed },
    });
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const headers = buildProxyHeaders(upstream, contentType);

  if (!upstream.ok && contentType.toLowerCase().includes('application/json')) {
    const body = await readJsonBody(upstream);
    console.warn(`[llm-proxy] chat/completions upstream error ${upstream.status}:`, body);
    const errorBody = JSON.stringify({ error: normalizeOpenAiError(body, upstream.status) });
    res.writeHead(upstream.status, {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(errorBody),
    });
    res.end(errorBody);
    return;
  }

  // Mirror successful SSE bytes verbatim.
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_interrupted', message })}\n\n`);
    } catch { /* socket may already be closed */ }
  } finally {
    res.end();
  }
}

async function proxyResponses(
  managedBackend: ManagedBackendClient,
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const session = managedBackend.getStoredSession();
  if (!session) {
    json(res, 401, {
      error: { code: 'missing_session', message: 'No managed session loaded in the orchestrator.' },
    });
    return;
  }

  if (isExpired(session.expiresAt)) {
    json(res, 401, {
      error: { code: 'expired_session', message: 'Managed session has expired locally.' },
    });
    return;
  }

  if (!body || typeof body !== 'object') {
    json(res, 400, {
      error: { code: 'bad_request', message: 'Body must be a JSON object.' },
    });
    return;
  }

  const responseRequest = body as Record<string, unknown>;
  const streamRequested = responseRequest.stream === true;
  if (streamRequested) {
    json(res, 501, {
      error: { code: 'unsupported', message: 'Streaming /responses is not implemented by the local managed proxy.' },
    });
    return;
  }

  const chatRequest = mapResponsesRequestToChatCompletion(responseRequest);

  let upstream: Response;
  try {
    upstream = await managedBackend.forwardChatCompletion(chatRequest);
  } catch (error) {
    const detailed = describeFetchFailure(error, `${managedBackend.backendBaseUrl}/v1/chat/completions`);
    console.warn(`[llm-proxy] responses ${detailed}`);
    json(res, 502, {
      error: { code: 'backend_unreachable', message: detailed },
    });
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  if (!upstream.ok && contentType.toLowerCase().includes('application/json')) {
    const errorBody = await readJsonBody(upstream);
    console.warn(`[llm-proxy] responses upstream error ${upstream.status}:`, errorBody);
    json(res, upstream.status, normalizeResponseApiError(errorBody, upstream.status));
    return;
  }

  const output = await collectResponsesOutputFromChatSse(upstream);
  const payload = buildResponsesPayload(responseRequest.model, output);
  const encoded = JSON.stringify(payload);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-cache, no-transform',
  });
  res.end(encoded);
}

/**
 * Build a single-line failure description from any throw thrown by `fetch()`.
 * undici (Node's built-in fetch) defaults to a useless "fetch failed" surface
 * and stashes the real OS-level reason on `.cause` — connect ECONNREFUSED,
 * getaddrinfo ENOTFOUND, certificate errors, AbortError, etc. We unwrap that
 * here so the orchestrator log and the 502 body both name the actual cause.
 *
 * Example outputs:
 *   "upstream POST http://127.0.0.1:8788/v1/chat/completions failed:
 *    fetch failed (connect ECONNREFUSED 127.0.0.1:8788)"
 *   "upstream POST https://backend.example/v1/chat/completions failed:
 *    timed out (AbortError)"
 */
function describeFetchFailure(error: unknown, url: string): string {
  const top = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  let causeText = '';
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    causeText = code ? `${code}: ${cause.message}` : cause.message;
  } else if (cause && typeof cause === 'object' && 'code' in cause) {
    causeText = String((cause as { code: unknown }).code);
  }
  return causeText
    ? `upstream POST ${url} failed: ${top} (${causeText})`
    : `upstream POST ${url} failed: ${top}`;
}

function isExpired(value: string): boolean {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

function buildProxyHeaders(upstream: Response, contentType: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  };

  const inferenceRequestId = upstream.headers.get('x-inference-request-id');
  if (inferenceRequestId) {
    headers['X-Inference-Request-Id'] = inferenceRequestId;
  }

  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) {
    headers['Retry-After'] = retryAfter;
  }

  return headers;
}

async function readJsonBody(upstream: Response): Promise<unknown> {
  try {
    return await upstream.json();
  } catch {
    return null;
  }
}

function normalizeOpenAiError(body: unknown, status: number): {
  message: string;
  type: string;
  code: string | number | null;
} {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (record.error && typeof record.error === 'object') {
      const error = record.error as Record<string, unknown>;
      return {
        message: typeof error.message === 'string' ? error.message : defaultStatusMessage(status),
        type: typeof error.type === 'string' ? error.type : defaultOpenAiErrorType(status),
        code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null,
      };
    }

    return {
      message: typeof record.message === 'string' ? record.message : defaultStatusMessage(status),
      type: defaultOpenAiErrorType(status),
      code: typeof record.error === 'string' || typeof record.error === 'number' ? record.error : null,
    };
  }

  return {
    message: defaultStatusMessage(status),
    type: defaultOpenAiErrorType(status),
    code: null,
  };
}

function defaultOpenAiErrorType(status: number): string {
  if (status === 429) return 'rate_limit_error';
  if (status === 401 || status === 403) return 'authentication_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

function defaultStatusMessage(status: number): string {
  if (status === 429) return 'Too many requests.';
  if (status === 503) return 'Service unavailable.';
  if (status === 401) return 'Authentication failed.';
  if (status === 403) return 'Forbidden.';
  return `Backend returned HTTP ${status}.`;
}

function mapResponsesRequestToChatCompletion(body: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    model: typeof body.model === 'string' ? body.model : 'openai/gpt-5.4',
    messages: buildMessagesFromResponsesBody(body),
  };

  const reasoning = body.reasoning;
  if (reasoning !== undefined) mapped.reasoning = reasoning;
  const toolChoice = mapResponsesToolChoiceToChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) mapped.tool_choice = toolChoice;
  const parallelToolCalls = body.parallel_tool_calls;
  if (parallelToolCalls !== undefined) mapped.parallel_tool_calls = parallelToolCalls;
  const tools = body.tools;
  if (Array.isArray(tools)) mapped.tools = mapResponsesToolsToChatTools(tools);

  return mapped;
}

function buildMessagesFromResponsesBody(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions = normalizeTextValue(body.instructions);
  if (instructions) {
    messages.push({ role: 'developer', content: instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const mapped = mapResponsesInputItemToChatMessage(item);
      if (mapped) messages.push(mapped);
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: '' });
  }

  return messages;
}

function mapResponsesInputItemToChatMessage(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;

  if (record.type === 'function_call') {
    const callId = stringValue(record.call_id) ?? stringValue(record.id) ?? `call_${Date.now().toString(36)}`;
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: callId,
        type: 'function',
        function: {
          name: stringValue(record.name) ?? 'tool',
          arguments: stringValue(record.arguments) ?? '{}',
        },
      }],
    };
  }

  if (record.type === 'function_call_output') {
    const callId = stringValue(record.call_id) ?? stringValue(record.tool_call_id);
    if (!callId) return null;
    return {
      role: 'tool',
      tool_call_id: callId,
      content: stringValue(record.output) ?? '',
    };
  }

  const role = normalizeChatRole(record.role);
  const content = normalizeTextValue(record.content);
  if (role && content !== null) {
    return { role, content };
  }

  return null;
}

function normalizeChatRole(value: unknown): 'developer' | 'system' | 'user' | 'assistant' | 'tool' | null {
  if (value !== 'developer' && value !== 'system' && value !== 'user' && value !== 'assistant' && value !== 'tool') {
    return null;
  }
  return value;
}

function normalizeTextValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? null : JSON.stringify(value);

  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    const text = stringValue(record.text) ?? stringValue(record.output_text) ?? stringValue(record.content);
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function mapResponsesToolsToChatTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const record = tool as Record<string, unknown>;
    if (record.type !== 'function') return tool;

    const nested = record.function;
    if (nested && typeof nested === 'object') return tool;

    const name = stringValue(record.name);
    if (!name) return tool;

    const chatFunction: Record<string, unknown> = { name };
    if (typeof record.description === 'string') chatFunction.description = record.description;
    if (record.parameters && typeof record.parameters === 'object') chatFunction.parameters = record.parameters;
    if (typeof record.strict === 'boolean') chatFunction.strict = record.strict;

    return {
      type: 'function',
      function: chatFunction,
    };
  });
}

function mapResponsesToolChoiceToChatToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
  const record = toolChoice as Record<string, unknown>;
  if (record.type !== 'function') return toolChoice;
  if (record.function && typeof record.function === 'object') return toolChoice;
  const name = stringValue(record.name);
  return name ? { type: 'function', function: { name } } : toolChoice;
}

interface ChatToolCallAccumulator {
  index: number;
  id: string | null;
  type: string | null;
  name: string;
  arguments: string;
}

async function collectResponsesOutputFromChatSse(upstream: Response): Promise<Array<Record<string, unknown>>> {
  if (!upstream.body) return buildResponseOutput('', []);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const toolCalls = new Map<number, ChatToolCallAccumulator>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const payloads = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const payload of payloads) {
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          const choices = parsed.choices;
          if (!Array.isArray(choices)) continue;
          for (const choice of choices) {
            if (!choice || typeof choice !== 'object') continue;
            const choiceRecord = choice as Record<string, unknown>;
            const delta = asRecord(choiceRecord.delta) ?? asRecord(choiceRecord.message);
            if (!delta) continue;
            const content = delta.content;
            if (typeof content === 'string') text += content;
            collectToolCallDeltas(delta.tool_calls, toolCalls);
          }
        } catch {
          // Ignore malformed keepalive frames.
        }
      }
    }
  }

  return buildResponseOutput(text, [...toolCalls.values()]);
}

function collectToolCallDeltas(raw: unknown, toolCalls: Map<number, ChatToolCallAccumulator>): void {
  if (!Array.isArray(raw)) return;

  raw.forEach((entry, fallbackIndex) => {
    const record = asRecord(entry);
    if (!record) return;
    const index = typeof record.index === 'number' ? record.index : fallbackIndex;
    const current = toolCalls.get(index) ?? {
      index,
      id: null,
      type: null,
      name: '',
      arguments: '',
    };

    if (typeof record.id === 'string' && record.id) current.id = record.id;
    if (typeof record.type === 'string' && record.type) current.type = record.type;

    const fn = asRecord(record.function);
    if (fn) {
      if (typeof fn.name === 'string') current.name += fn.name;
      if (typeof fn.arguments === 'string') current.arguments += fn.arguments;
    }

    toolCalls.set(index, current);
  });
}

function buildResponseOutput(
  text: string,
  toolCalls: ChatToolCallAccumulator[],
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (text || toolCalls.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
    });
  }

  for (const toolCall of toolCalls.sort((a, b) => a.index - b.index)) {
    const callId = toolCall.id ?? `call_${Date.now().toString(36)}_${toolCall.index}`;
    output.push({
      type: 'function_call',
      id: responseFunctionCallId(callId),
      call_id: callId,
      name: toolCall.name || 'tool',
      arguments: toolCall.arguments || '{}',
      status: 'completed',
    });
  }

  return output;
}

function responseFunctionCallId(callId: string): string {
  if (callId.startsWith('fc_')) return callId;
  return `fc_${callId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function buildResponsesPayload(model: unknown, output: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    model: typeof model === 'string' ? model : 'openai/gpt-5.4',
    status: 'completed',
    output,
  };
}

function normalizeResponseApiError(body: unknown, status: number): Record<string, unknown> {
  const normalized = normalizeOpenAiError(body, status);
  return {
    error: normalized.type === 'rate_limit_error' ? 'rate_limit_exceeded' : normalized.code ?? 'backend_error',
    message: normalized.message,
  };
}

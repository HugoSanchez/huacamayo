import type { InferenceRequestUsage } from './types.ts';

export interface OpenRouterClientOptions {
  apiKey: string;
  baseUrl?: string;
  appUrl?: string;
  appTitle?: string;
}

export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

export interface OpenRouterChatStream {
  /** SSE response body. Bytes from this stream are pass-through compatible with OpenAI-style chunks. */
  body: ReadableStream<Uint8Array>;
  /** Resolves with the cumulative usage parsed from the stream's final chunk. */
  usagePromise: Promise<InferenceRequestUsage>;
  /** Resolves with the OpenRouter request id if the response carried `id` field, otherwise null. */
  providerRequestIdPromise: Promise<string | null>;
  /** Resolves when the stream ends with any OpenRouter mid-stream error event that was observed. */
  errorPromise: Promise<OpenRouterStreamError | null>;
}

export interface OpenRouterStreamError {
  code: string;
  message: string;
  provider: string | null;
  rawCode: string | number | null;
}

export interface OpenRouterErrorOptions {
  providerStatus?: number | null;
  retryAfterSec?: number | null;
  providerErrorCode?: string | number | null;
}

export class OpenRouterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly providerStatus: number | null;
  readonly retryAfterSec: number | null;
  readonly providerErrorCode: string | number | null;

  constructor(status: number, code: string, message: string, options: OpenRouterErrorOptions = {}) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
    this.providerStatus = options.providerStatus ?? null;
    this.retryAfterSec = options.retryAfterSec ?? null;
    this.providerErrorCode = options.providerErrorCode ?? null;
  }
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly appUrl: string | null;
  private readonly appTitle: string;

  constructor(options: OpenRouterClientOptions) {
    if (!options.apiKey) {
      throw new Error('OpenRouterClient requires an apiKey.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.appUrl = options.appUrl ?? null;
    this.appTitle = options.appTitle ?? 'verso';
  }

  /**
   * POST /chat/completions with stream=true. The privacy posture below comes
   * straight from the managed-backend-v1 plan: opt out of provider data
   * collection and prefer zero-data-retention routes.
   */
  async streamChatCompletion(
    request: OpenRouterChatRequest | Record<string, unknown>,
  ): Promise<OpenRouterChatStream> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Title': this.appTitle,
    };
    if (this.appUrl) {
      headers['HTTP-Referer'] = this.appUrl;
    }

    // We pass the caller's body through verbatim — that's the whole point of
    // an OpenAI-compatible proxy — but enforce stream=true (we are streaming),
    // stream_options.include_usage (so usage metadata lands in the final chunk),
    // and the privacy posture from the V1 plan.
    const merged: Record<string, unknown> = {
      ...(request as Record<string, unknown>),
      stream: true,
      stream_options: { include_usage: true },
      provider: {
        ...((request as Record<string, unknown>).provider as Record<string, unknown> ?? {}),
        data_collection: 'deny',
        zdr: true,
      },
    };
    const withCache = injectAnthropicCacheControl(merged);
    const body = JSON.stringify(withCache);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenRouterError(502, 'provider_unreachable', `OpenRouter request failed: ${message}`);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      const providerError = parseProviderError(text);
      const retryAfterSec = parseRetryAfter(response.headers.get('retry-after'));
      const code = classifyProviderError(response.status, providerError?.code ?? null);
      throw new OpenRouterError(
        mapProviderStatus(response.status),
        code,
        formatProviderErrorMessage(response.status, providerError?.message ?? text, retryAfterSec),
        {
          providerStatus: response.status,
          retryAfterSec,
          providerErrorCode: providerError?.code ?? null,
        },
      );
    }

    if (!response.body) {
      throw new OpenRouterError(502, 'provider_empty_stream', 'OpenRouter response body was empty.');
    }

    return tapUsage(response.body);
  }
}

/**
 * Splits OpenRouter's SSE stream into a downstream-relayable byte stream and
 * a side-channel that parses the final usage chunk. We don't buffer the whole
 * response — each chunk is forwarded immediately so first-token latency is
 * unaffected.
 */
function tapUsage(source: ReadableStream<Uint8Array>): OpenRouterChatStream {
  const decoder = new TextDecoder();
  let pendingLine = '';
  let usage: InferenceRequestUsage = {
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    estimatedCostUsd: null,
    providerRequestId: null,
  };
  let providerRequestId: string | null = null;
  let streamError: OpenRouterStreamError | null = null;

  let resolveUsage!: (value: InferenceRequestUsage) => void;
  let resolveRequestId!: (value: string | null) => void;
  let resolveStreamError!: (value: OpenRouterStreamError | null) => void;
  const usagePromise = new Promise<InferenceRequestUsage>((resolve) => { resolveUsage = resolve; });
  const providerRequestIdPromise = new Promise<string | null>((resolve) => { resolveRequestId = resolve; });
  const errorPromise = new Promise<OpenRouterStreamError | null>((resolve) => { resolveStreamError = resolve; });

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pendingLine += decoder.decode(chunk, { stream: true });
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]' || payload.length === 0) continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          if (typeof parsed.id === 'string' && providerRequestId === null) {
            providerRequestId = parsed.id;
          }
          if (parsed.usage && typeof parsed.usage === 'object') {
            usage = readUsage(parsed.usage as Record<string, unknown>, usage);
          }
          const parsedError = readStreamError(parsed);
          if (parsedError) {
            streamError = parsedError;
          }
        } catch {
          // Tolerate non-JSON keepalive lines from OpenRouter.
        }
      }
    },
    flush() {
      usage.providerRequestId = providerRequestId;
      resolveUsage(usage);
      resolveRequestId(providerRequestId);
      resolveStreamError(streamError);
    },
  });

  return {
    body: source.pipeThrough(transform),
    usagePromise,
    providerRequestIdPromise,
    errorPromise,
  };
}

function readUsage(raw: Record<string, unknown>, prev: InferenceRequestUsage): InferenceRequestUsage {
  const promptTokens = pickNumber(raw, 'prompt_tokens');
  const completionTokens = pickNumber(raw, 'completion_tokens');
  const inputTokens = promptTokens ?? pickNumber(raw, 'input_tokens') ?? prev.inputTokens;
  const outputTokens = completionTokens ?? pickNumber(raw, 'output_tokens') ?? prev.outputTokens;

  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
    ? raw.prompt_tokens_details as Record<string, unknown>
    : null;
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object'
    ? raw.completion_tokens_details as Record<string, unknown>
    : null;

  const cachedTokens = (promptDetails && pickNumber(promptDetails, 'cached_tokens')) ?? prev.cachedTokens;
  const reasoningTokens = (completionDetails && pickNumber(completionDetails, 'reasoning_tokens')) ?? prev.reasoningTokens;
  const estimatedCostUsd = pickNumber(raw, 'cost') ?? prev.estimatedCostUsd;

  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    estimatedCostUsd,
    providerRequestId: prev.providerRequestId,
  };
}

/**
 * Inject Anthropic prompt-cache breakpoints on stable prefix content. Anthropic
 * (unlike OpenAI which caches automatically) only caches prefixes that are
 * explicitly marked with `cache_control: {type: "ephemeral"}`. Without these
 * markers, every Hermes turn re-bills the system prompt + tool schemas + the
 * entire growing conversation history at full rate.
 *
 * Anthropic allows up to 4 breakpoints. We use three, in order of stability:
 *   1. End of system / developer message  — ~5K tokens, immutable
 *   2. End of tools=[] array              — ~30K tokens, changes only when
 *                                            the agent's tool set changes
 *   3. End of conversation history        — ~75K+ tokens on later turns,
 *                                            grows each turn but earlier
 *                                            content stays byte-identical
 *
 * The third breakpoint is the high-leverage one for multi-turn tool-calling
 * conversations: every turn after the first reuses the prior history as a
 * cache hit, with only the new user message + latest tool result paying full
 * rate. Cache writes cost 1.25× input rate, reads cost 0.1×, so caching
 * pays off after a single reuse.
 *
 * No-op for non-Anthropic models so OpenAI/Google paths are untouched.
 */
export function injectAnthropicCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === 'string' ? body.model : '';
  if (!model.startsWith('anthropic/')) return body;

  const next: Record<string, unknown> = { ...body };

  // 1. Mark the system / developer message. Convert string content to the
  //    array-of-blocks shape Anthropic expects when we need to attach
  //    cache_control to a specific block.
  if (Array.isArray(next.messages)) {
    let systemMarked = false;
    next.messages = (next.messages as unknown[]).map((rawMsg) => {
      if (systemMarked) return rawMsg;
      if (!rawMsg || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) return rawMsg;
      const msg = rawMsg as Record<string, unknown>;
      const role = msg.role;
      if (role !== 'system' && role !== 'developer') return rawMsg;

      let content = msg.content;
      if (typeof content === 'string') {
        content = [{ type: 'text', text: content }];
      }
      if (!Array.isArray(content) || content.length === 0) return rawMsg;

      const blocks = content as Array<Record<string, unknown>>;
      const lastIndex = blocks.length - 1;
      const nextBlocks = blocks.map((block, idx) =>
        idx === lastIndex
          ? { ...block, cache_control: { type: 'ephemeral' } }
          : block,
      );
      systemMarked = true;
      return { ...msg, content: nextBlocks };
    });
  }

  // 2. Mark the last tool definition. Caches the entire `tools` array prefix
  //    (which on our Hermes setup is ~30KB of schemas billed on every turn).
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const tools = [...(next.tools as Array<Record<string, unknown>>)];
    const last = tools[tools.length - 1];
    if (last && typeof last === 'object') {
      tools[tools.length - 1] = { ...last, cache_control: { type: 'ephemeral' } };
      next.tools = tools;
    }
  }

  // 3. Mark the end of conversation history. On a 6-iteration tool-call turn
  //    where prior turns averaged 75K input tokens, this is the dominant
  //    cost source — without this breakpoint, even with system+tools cached,
  //    every iteration re-bills the full history at $5/M.
  if (Array.isArray(next.messages) && next.messages.length > 0) {
    const messages = [...(next.messages as Array<Record<string, unknown>>)];
    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    if (lastMsg && typeof lastMsg === 'object' && lastMsg.role !== 'system' && lastMsg.role !== 'developer') {
      messages[lastIdx] = applyCacheControlToMessage(lastMsg);
      next.messages = messages;
    }
  }

  return next;
}

/**
 * Add cache_control: ephemeral to the LAST content block of a message.
 * Mirrors what we do for the system message but applies to whichever block
 * the message ends with (text, tool_use, tool_result, image, …).
 */
function applyCacheControlToMessage(msg: Record<string, unknown>): Record<string, unknown> {
  let content = msg.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content) || content.length === 0) {
    return msg;
  }
  const blocks = content as Array<Record<string, unknown>>;
  const lastIdx = blocks.length - 1;
  const lastBlock = blocks[lastIdx];
  if (!lastBlock || typeof lastBlock !== 'object') return msg;
  const nextBlocks = blocks.map((block, idx) =>
    idx === lastIdx
      ? { ...block, cache_control: { type: 'ephemeral' } }
      : block,
  );
  return { ...msg, content: nextBlocks };
}

function pickNumber(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseProviderError(text: string): { code: string | number | null; message: string | null } | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rawError = (parsed as Record<string, unknown>).error;
    if (!rawError || typeof rawError !== 'object') return null;
    const error = rawError as Record<string, unknown>;
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null;
    const message = typeof error.message === 'string' ? error.message : null;
    return { code, message };
  } catch {
    return null;
  }
}

function readStreamError(parsed: Record<string, unknown>): OpenRouterStreamError | null {
  const rawError = parsed.error;
  if (!rawError || typeof rawError !== 'object') return null;
  const error = rawError as Record<string, unknown>;
  const rawCode = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null;
  const message = typeof error.message === 'string' && error.message.trim().length > 0
    ? error.message
    : 'OpenRouter stream ended with an error.';
  const provider = typeof parsed.provider === 'string' ? parsed.provider : null;
  return {
    code: classifyProviderError(typeof rawCode === 'number' ? rawCode : null, rawCode),
    message,
    provider,
    rawCode,
  };
}

function classifyProviderError(status: number | null, providerCode: string | number | null): string {
  const normalized = String(providerCode ?? '').toLowerCase();
  if (status === 429 || normalized === '429' || normalized.includes('rate_limit') || normalized.includes('too_many')) {
    return 'provider_rate_limited';
  }
  if (status === 503 || normalized === '503' || normalized.includes('unavailable')) {
    return 'provider_unavailable';
  }
  if (status === 402 || normalized === '402' || normalized.includes('credit') || normalized.includes('insufficient')) {
    return 'provider_insufficient_credits';
  }
  return 'provider_error';
}

function formatProviderErrorMessage(status: number, rawMessage: string | null | undefined, retryAfterSec: number | null): string {
  const providerMessage = rawMessage && rawMessage.trim().length > 0 ? rawMessage.trim() : 'no body';
  const retryHint = retryAfterSec !== null ? ` Retry after ${retryAfterSec}s.` : '';
  if (status === 429) {
    return `OpenRouter rate limited the request.${retryHint} ${providerMessage}`.trim();
  }
  if (status === 503) {
    return `OpenRouter has no available provider for this request.${retryHint} ${providerMessage}`.trim();
  }
  return `OpenRouter returned HTTP ${status}.${retryHint} ${providerMessage}`.trim();
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds);
  }

  const retryAt = Date.parse(value);
  if (!Number.isNaN(retryAt)) {
    const secondsUntil = Math.ceil((retryAt - Date.now()) / 1000);
    return secondsUntil > 0 ? secondsUntil : null;
  }

  return null;
}

function mapProviderStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  if (status === 429) return 429;
  if (status === 503) return 503;
  if (status >= 500) return 502;
  return 502;
}

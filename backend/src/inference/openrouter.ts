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
}

export class OpenRouterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = code;
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
    this.appTitle = options.appTitle ?? 'Vervo';
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
    const body = JSON.stringify(merged);

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
      throw new OpenRouterError(
        mapProviderStatus(response.status),
        'provider_error',
        `OpenRouter returned HTTP ${response.status}: ${text || 'no body'}`,
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

  let resolveUsage!: (value: InferenceRequestUsage) => void;
  let resolveRequestId!: (value: string | null) => void;
  const usagePromise = new Promise<InferenceRequestUsage>((resolve) => { resolveUsage = resolve; });
  const providerRequestIdPromise = new Promise<string | null>((resolve) => { resolveRequestId = resolve; });

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
        } catch {
          // Tolerate non-JSON keepalive lines from OpenRouter.
        }
      }
    },
    flush() {
      usage.providerRequestId = providerRequestId;
      resolveUsage(usage);
      resolveRequestId(providerRequestId);
    },
  });

  return {
    body: source.pipeThrough(transform),
    usagePromise,
    providerRequestIdPromise,
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

function mapProviderStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  if (status === 429) return 429;
  if (status >= 500) return 502;
  return 502;
}

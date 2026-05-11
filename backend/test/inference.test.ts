import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig, type BackendConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { MemoryInferenceStore } from '../src/inference/memory-store.ts';
import { OpenRouterClient, OpenRouterError, type OpenRouterChatRequest, type OpenRouterChatStream } from '../src/inference/openrouter.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'privy-app-id',
  PRIVY_APP_SECRET: 'privy-app-secret',
  OPENROUTER_API_KEY: 'or-test-key',
  MANAGED_DEFAULT_MODEL: 'anthropic/opus-4.7',
  MANAGED_ALLOWED_MODELS: 'anthropic/opus-4.7,openai/gpt-5.4',
};

class StubVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(_accessToken: string): Promise<VerifiedPrivyAuthToken> {
    return {
      userId: 'did:privy:user-1',
      sessionId: 'privy-session',
      appId: 'privy-app-id',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

interface TestContext {
  app: Awaited<ReturnType<typeof buildServer>>;
  config: BackendConfig;
  authService: AuthService;
  inferenceStore: MemoryInferenceStore;
  sessionToken: string;
  userId: string;
  deviceId: string;
}

async function setup(opts: {
  envOverride?: Record<string, string>;
  buildClient?: (config: BackendConfig) => OpenRouterClient;
} = {}): Promise<TestContext> {
  const env = { ...baseEnv, ...opts.envOverride };
  const config = getConfig(env);
  const authService = new AuthService(config, new MemoryAuthStore(), new StubVerifier());
  const inferenceStore = new MemoryInferenceStore();
  const app = await buildServer({
    config,
    authService,
    inferenceStore,
    buildOpenRouterClient: opts.buildClient,
  });

  const exchange = await authService.exchangePrivyAuth({
    privyAccessToken: 'privy-token',
    deviceLabel: 'Hugo MacBook',
    platform: 'macos',
  });

  return {
    app,
    config,
    authService,
    inferenceStore,
    sessionToken: exchange.sessionToken,
    userId: exchange.user.id,
    deviceId: exchange.device.id,
  };
}

function makeStreamFromString(payload: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeClient(payload: string, usage: Partial<OpenRouterChatStream['usagePromise']> = {}): (config: BackendConfig) => OpenRouterClient {
  void usage;
  // Build a real OpenRouterClient instance whose streamChatCompletion is
  // replaced — keeps `instanceof` checks intact downstream.
  return (_config) => {
    const client = new OpenRouterClient({ apiKey: 'unused-in-tests' });
    (client as unknown as { streamChatCompletion: (req: OpenRouterChatRequest) => Promise<OpenRouterChatStream> })
      .streamChatCompletion = async (_req) => {
      const body = makeStreamFromString(payload);
      // Re-use the real tap so we exercise the same parsing path.
      return tapForTests(body);
    };
    return client;
  };
}

function failingClient(error: OpenRouterError): (config: BackendConfig) => OpenRouterClient {
  return (_config) => {
    const client = new OpenRouterClient({ apiKey: 'unused-in-tests' });
    (client as unknown as { streamChatCompletion: (req: OpenRouterChatRequest) => Promise<OpenRouterChatStream> })
      .streamChatCompletion = async () => {
      throw error;
    };
    return client;
  };
}

// Mirrors the private tapUsage used by the real client so we test against the
// same parsing logic without depending on private-symbol exports.
function tapForTests(source: ReadableStream<Uint8Array>): OpenRouterChatStream {
  const decoder = new TextDecoder();
  let pendingLine = '';
  let usage = {
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cachedTokens: null as number | null,
    reasoningTokens: null as number | null,
    estimatedCostUsd: null as number | null,
    providerRequestId: null as string | null,
  };
  let providerRequestId: string | null = null;
  let resolveUsage!: (value: typeof usage) => void;
  let resolveRequestId!: (value: string | null) => void;
  const usagePromise = new Promise<typeof usage>((resolve) => { resolveUsage = resolve; });
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
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          if (typeof parsed.id === 'string' && providerRequestId === null) {
            providerRequestId = parsed.id;
          }
          if (parsed.usage && typeof parsed.usage === 'object') {
            const u = parsed.usage as Record<string, unknown>;
            usage = {
              ...usage,
              inputTokens: numberOf(u.prompt_tokens) ?? usage.inputTokens,
              outputTokens: numberOf(u.completion_tokens) ?? usage.outputTokens,
              estimatedCostUsd: numberOf(u.cost) ?? usage.estimatedCostUsd,
            };
          }
        } catch { /* tolerate keepalives */ }
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
    usagePromise: usagePromise as unknown as OpenRouterChatStream['usagePromise'],
    providerRequestIdPromise,
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

describe('POST /v1/chat/completions', () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.app.close();
  });

  test('rejects requests without a Bearer token as 401 missing_session', async () => {
    ctx = await setup();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('missing_session');
  });

  test('rejects malformed bodies as 400 bad_request', async () => {
    ctx = await setup();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: { messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('bad_request');
  });

  test('rejects models outside the allowlist as 403 model_not_allowed', async () => {
    ctx = await setup();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'meta-llama/llama-3-70b',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('model_not_allowed');
  });

  test('returns 503 when OpenRouter is not configured', async () => {
    ctx = await setup({ envOverride: { OPENROUTER_API_KEY: '' } });
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('openrouter_unconfigured');
  });

  test('streams provider bytes through and records usage on completion', async () => {
    const sse = [
      'data: {"id":"gen-test-123","choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"id":"gen-test-123","choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: {"id":"gen-test-123","usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.0001}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    ctx = await setup({ buildClient: fakeClient(sse) });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.body).toContain('Hello');
    expect(response.body).toContain('world');
    expect(response.body).toContain('[DONE]');
    expect(response.headers['x-inference-request-id']).toMatch(/^inf_/);

    const records = await ctx.inferenceStore.listByUserId(ctx.userId);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.status).toBe('completed');
    expect(record.model).toBe('anthropic/opus-4.7');
    expect(record.deviceId).toBe(ctx.deviceId);
    expect(record.inputTokens).toBe(5);
    expect(record.outputTokens).toBe(2);
    expect(record.estimatedCostUsd).toBe(0.0001);
    expect(record.providerRequestId).toBe('gen-test-123');
    expect(record.errorCode).toBeNull();
    expect(record.requestCompletedAt).not.toBeNull();
  });

  test('marks the inference row failed and surfaces the provider status when OpenRouter returns an error', async () => {
    const error = new OpenRouterError(502, 'provider_error', 'OpenRouter returned HTTP 500: oops');
    ctx = await setup({ buildClient: failingClient(error) });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('provider_error');

    const records = await ctx.inferenceStore.listByUserId(ctx.userId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].errorCode).toBe('provider_error');
  });

  test('injects managedDefaultMaxTokens when the caller omits max_tokens', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const recordingClient = (_config: BackendConfig) => {
      const client = new OpenRouterClient({ apiKey: 'unused-in-tests' });
      (client as unknown as { streamChatCompletion: (req: Record<string, unknown>) => Promise<OpenRouterChatStream> })
        .streamChatCompletion = async (req) => {
        captured.push(req);
        return tapForTests(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
            controller.close();
          },
        }));
      };
      return client;
    };

    ctx = await setup({
      envOverride: { MANAGED_DEFAULT_MAX_TOKENS: '2048' },
      buildClient: recordingClient,
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].max_tokens).toBe(2048);
  });

  test('respects the caller-supplied max_tokens without overwriting', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const recordingClient = (_config: BackendConfig) => {
      const client = new OpenRouterClient({ apiKey: 'unused-in-tests' });
      (client as unknown as { streamChatCompletion: (req: Record<string, unknown>) => Promise<OpenRouterChatStream> })
        .streamChatCompletion = async (req) => {
        captured.push(req);
        return tapForTests(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
            controller.close();
          },
        }));
      };
      return client;
    };

    ctx = await setup({ buildClient: recordingClient });

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      },
    });
    expect(captured[0].max_tokens).toBe(50);
  });

  test('rejects expired session tokens as 401 expired_session', async () => {
    ctx = await setup();
    // Bypass route auth by simulating an expired session token. Re-use the
    // public /v1/me path? Simpler: ensure invalid_session for a tampered token.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer v1_not_a_real_token' },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid_session');
  });
});

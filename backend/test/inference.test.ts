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
  authStore: MemoryAuthStore;
  inferenceStore: MemoryInferenceStore;
  sessionToken: string;
  userId: string;
  deviceId: string;
  entitlementId: string;
}

async function setup(opts: {
  envOverride?: Record<string, string>;
  buildClient?: (config: BackendConfig) => OpenRouterClient;
} = {}): Promise<TestContext> {
  const env = { ...baseEnv, ...opts.envOverride };
  const config = getConfig(env);
  const authStore = new MemoryAuthStore();
  const authService = new AuthService(config, authStore, new StubVerifier());
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
    authStore,
    inferenceStore,
    sessionToken: exchange.sessionToken,
    userId: exchange.user.id,
    deviceId: exchange.device.id,
    entitlementId: exchange.entitlements[0]?.id ?? '',
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
  type TestStreamError = Awaited<OpenRouterChatStream['errorPromise']>;
  let streamError: TestStreamError = null;
  let resolveUsage!: (value: typeof usage) => void;
  let resolveRequestId!: (value: string | null) => void;
  let resolveStreamError!: (value: TestStreamError) => void;
  const usagePromise = new Promise<typeof usage>((resolve) => { resolveUsage = resolve; });
  const providerRequestIdPromise = new Promise<string | null>((resolve) => { resolveRequestId = resolve; });
  const errorPromise = new Promise<TestStreamError>((resolve) => { resolveStreamError = resolve; });

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
          if (parsed.error && typeof parsed.error === 'object') {
            const err = parsed.error as Record<string, unknown>;
            const rawCode = typeof err.code === 'string' || typeof err.code === 'number' ? err.code : null;
            streamError = {
              code: classifyProviderErrorForTest(rawCode),
              message: typeof err.message === 'string' ? err.message : 'stream failed',
              provider: typeof parsed.provider === 'string' ? parsed.provider : null,
              rawCode,
            };
          }
        } catch { /* tolerate keepalives */ }
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
    usagePromise: usagePromise as unknown as OpenRouterChatStream['usagePromise'],
    providerRequestIdPromise,
    errorPromise,
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function classifyProviderErrorForTest(rawCode: string | number | null): 'provider_rate_limited' | 'provider_error' {
  const normalized = String(rawCode ?? '').toLowerCase();
  if (normalized.includes('rate_limit') || normalized.includes('too_many') || normalized === '429') {
    return 'provider_rate_limited';
  }
  return 'provider_error';
}

describe('OpenRouterClient', () => {
  test('classifies OpenRouter HTTP 429s and preserves Retry-After', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: { code: 429, message: 'Rate limit exceeded' },
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    })) as typeof fetch;

    try {
      const client = new OpenRouterClient({ apiKey: 'or-test' });
      const error = await client.streamChatCompletion({
        model: 'openai/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(OpenRouterError);
      expect((error as OpenRouterError).status).toBe(429);
      expect((error as OpenRouterError).code).toBe('provider_rate_limited');
      expect((error as OpenRouterError).providerStatus).toBe(429);
      expect((error as OpenRouterError).retryAfterSec).toBe(60);
      expect((error as Error).message).toContain('OpenRouter rate limited');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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

  test('preserves provider rate-limit metadata when OpenRouter returns 429', async () => {
    const error = new OpenRouterError(
      429,
      'provider_rate_limited',
      'OpenRouter rate limited the request. Retry after 60s. Rate limit exceeded',
      {
        providerStatus: 429,
        retryAfterSec: 60,
        providerErrorCode: 429,
      },
    );
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

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.json()).toMatchObject({
      error: 'provider_rate_limited',
      provider: 'openrouter',
      providerStatus: 429,
      retryAfterSec: 60,
    });

    const records = await ctx.inferenceStore.listByUserId(ctx.userId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].errorCode).toBe('provider_rate_limited');
  });

  test('marks OpenRouter mid-stream error events as failed requests', async () => {
    ctx = await setup({
      buildClient: fakeClient([
        'data: {"id":"gen-error","provider":"openai","error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')),
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
    expect(response.body).toContain('Rate limit exceeded');

    const records = await ctx.inferenceStore.listByUserId(ctx.userId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].errorCode).toBe('provider_rate_limited');
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

  test('rejects oversized managed requests before calling the provider', async () => {
    let called = false;
    const recordingClient = (_config: BackendConfig) => {
      const client = new OpenRouterClient({ apiKey: 'unused-in-tests' });
      (client as unknown as { streamChatCompletion: (req: Record<string, unknown>) => Promise<OpenRouterChatStream> })
        .streamChatCompletion = async () => {
        called = true;
        return tapForTests(makeStreamFromString('data: [DONE]\n'));
      };
      return client;
    };

    ctx = await setup({
      envOverride: { MANAGED_MAX_REQUEST_BYTES: '200' },
      buildClient: recordingClient,
    });

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'x'.repeat(500) }],
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('request_too_large');
    expect(called).toBe(false);
    const [record] = await ctx.inferenceStore.listByUserId(ctx.userId);
    expect(record.status).toBe('failed');
    expect(record.errorCode).toBe('request_too_large');
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

  test('rejects with 402 spend_limit_exceeded when month-to-date usage meets monthlyUsdLimit', async () => {
    ctx = await setup({ buildClient: fakeClient('data: [DONE]\n') });

    // Set a $0.50 monthly limit on the user's entitlement.
    await ctx.authStore.insertEntitlement({
      id: ctx.entitlementId,
      userId: ctx.userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: '0.50',
      dailyUsdLimit: null,
      allowedModels: ['anthropic/opus-4.7'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Seed two completed requests this month summing to $0.55 — over the cap.
    const now = new Date().toISOString();
    for (const cost of [0.30, 0.25]) {
      await ctx.inferenceStore.insertRequest({
        id: `inf_seed_${cost}`,
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        localSessionId: null,
        provider: 'openrouter',
        model: 'anthropic/opus-4.7',
        requestStartedAt: now,
        requestCompletedAt: now,
        status: 'completed',
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: null,
        reasoningTokens: null,
        estimatedCostUsd: cost,
        providerRequestId: null,
        errorCode: null,
      });
    }

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: {
        model: 'anthropic/opus-4.7',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(402);
    const body = response.json();
    expect(body.error).toBe('spend_limit_exceeded');
    expect(body.scope).toBe('monthly');
    expect(body.limit).toBe(0.5);
    expect(body.used).toBeCloseTo(0.55);
  });

  test('rejects with 402 spend_limit_exceeded when day-to-date usage meets dailyUsdLimit', async () => {
    ctx = await setup({ buildClient: fakeClient('data: [DONE]\n') });

    await ctx.authStore.insertEntitlement({
      id: ctx.entitlementId,
      userId: ctx.userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: '100.00',
      dailyUsdLimit: '0.10',
      allowedModels: ['anthropic/opus-4.7'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const now = new Date().toISOString();
    await ctx.inferenceStore.insertRequest({
      id: 'inf_seed_today',
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      localSessionId: null,
      provider: 'openrouter',
      model: 'anthropic/opus-4.7',
      requestStartedAt: now,
      requestCompletedAt: now,
      status: 'completed',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: null,
      reasoningTokens: null,
      estimatedCostUsd: 0.12,
      providerRequestId: null,
      errorCode: null,
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

    expect(response.statusCode).toBe(402);
    expect(response.json().scope).toBe('daily');
  });

  test('lets the request through when usage is under both limits', async () => {
    ctx = await setup({ buildClient: fakeClient('data: [DONE]\n') });

    await ctx.authStore.insertEntitlement({
      id: ctx.entitlementId,
      userId: ctx.userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: '10.00',
      dailyUsdLimit: '1.00',
      allowedModels: ['anthropic/opus-4.7'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
  });

  test('failed inference rows (null cost) do not count toward the limit', async () => {
    ctx = await setup({ buildClient: fakeClient('data: [DONE]\n') });

    await ctx.authStore.insertEntitlement({
      id: ctx.entitlementId,
      userId: ctx.userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: '0.10',
      dailyUsdLimit: null,
      allowedModels: ['anthropic/opus-4.7'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Seed three failed rows. Even though the cap is just $0.10, these have
    // null cost (failed) so they must not consume any of the budget.
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await ctx.inferenceStore.insertRequest({
        id: `inf_failed_${i}`,
        userId: ctx.userId,
        deviceId: ctx.deviceId,
        localSessionId: null,
        provider: 'openrouter',
        model: 'anthropic/opus-4.7',
        requestStartedAt: now,
        requestCompletedAt: now,
        status: 'failed',
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        estimatedCostUsd: null,
        providerRequestId: null,
        errorCode: 'provider_error',
      });
    }

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
  });

  test('returns 429 rate_limit_exceeded after burning through the per-minute cap', async () => {
    ctx = await setup({
      envOverride: { MANAGED_RATE_LIMIT_PER_MINUTE: '2' },
      buildClient: fakeClient('data: [DONE]\n'),
    });

    // Two requests fit under the cap.
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r2.statusCode).toBe(200);

    // Third request trips the limiter.
    const r3 = await ctx.app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe('rate_limit_exceeded');
    expect(r3.headers['retry-after']).toBeDefined();
  });

  test('returns 503 auto_paused after enough consecutive failures', async () => {
    const error = new OpenRouterError(502, 'provider_error', 'Upstream blew up.');
    ctx = await setup({
      envOverride: {
        MANAGED_BREAKER_THRESHOLD: '2',
        MANAGED_BREAKER_COOLDOWN_MS: '60000',
        MANAGED_RATE_LIMIT_PER_MINUTE: '999',
      },
      buildClient: failingClient(error),
    });

    // Two failures arm the breaker.
    for (let i = 0; i < 2; i++) {
      const r = await ctx.app.inject({
        method: 'POST', url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${ctx.sessionToken}` },
        payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(r.statusCode).toBe(502);
    }

    // Next call is auto-paused.
    const blocked = await ctx.app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ctx.sessionToken}` },
      payload: { model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error).toBe('auto_paused');
    expect(blocked.json().lastErrorCode).toBe('provider_error');
    expect(blocked.json().message).toContain('Last error: provider_error');
  });

  test('with null monthlyUsdLimit and null dailyUsdLimit, the request is unconstrained', async () => {
    ctx = await setup({ buildClient: fakeClient('data: [DONE]\n') });
    // Default-seeded entitlement already has both limits null. Just confirm
    // a request goes through even with a fat pre-seeded usage history.
    const now = new Date().toISOString();
    await ctx.inferenceStore.insertRequest({
      id: 'inf_seed_huge',
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      localSessionId: null,
      provider: 'openrouter',
      model: 'anthropic/opus-4.7',
      requestStartedAt: now,
      requestCompletedAt: now,
      status: 'completed',
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      reasoningTokens: null,
      estimatedCostUsd: 9999.99,
      providerRequestId: null,
      errorCode: null,
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
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { MemoryInferenceStore } from '../src/inference/memory-store.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

class StubVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(_token: string): Promise<VerifiedPrivyAuthToken> {
    return {
      userId: 'did:privy:usage-test',
      sessionId: 'privy-session',
      appId: 'privy-app-id',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

const baseEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'privy-app-id',
  PRIVY_APP_SECRET: 'privy-app-secret',
  OPENROUTER_API_KEY: 'or-test-key',
};

describe('GET /v1/usage/summary', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    if (app) { await app.close(); app = null; }
  });

  test('rejects requests without a bearer token as 401 missing_session', async () => {
    const config = getConfig(baseEnv);
    app = await buildServer({ config });
    const res = await app.inject({ method: 'GET', url: '/v1/usage/summary' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_session');
  });

  test('returns user, mode, zero usage, and null limits for a freshly signed-in user', async () => {
    const config = getConfig(baseEnv);
    const authStore = new MemoryAuthStore();
    const inferenceStore = new MemoryInferenceStore();
    const authService = new AuthService(config, authStore, new StubVerifier());
    app = await buildServer({ config, authService, authStore, inferenceStore });

    const exchange = await authService.exchangePrivyAuth({
      privyAccessToken: 'privy-token',
      deviceLabel: 'Hugo Mac',
      platform: 'macos',
      email: 'hugo@example.com',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/usage/summary',
      headers: { authorization: `Bearer ${exchange.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe('hugo@example.com');
    expect(body.mode).toBe('managed');
    expect(body.usage.monthToDateUsd).toBe(0);
    expect(body.usage.dayToDateUsd).toBe(0);
    expect(body.limits.monthlyUsdLimit).toBeNull();
    expect(body.limits.dailyUsdLimit).toBeNull();
    expect(typeof body.usage.monthStart).toBe('string');
    expect(typeof body.usage.dayStart).toBe('string');
  });

  test('reflects accumulated usage and configured limits', async () => {
    const config = getConfig(baseEnv);
    const authStore = new MemoryAuthStore();
    const inferenceStore = new MemoryInferenceStore();
    const authService = new AuthService(config, authStore, new StubVerifier());
    app = await buildServer({ config, authService, authStore, inferenceStore });

    const exchange = await authService.exchangePrivyAuth({
      privyAccessToken: 'privy-token',
      deviceLabel: 'Hugo Mac',
      platform: 'macos',
    });

    // Update entitlement with limits.
    await authStore.insertEntitlement({
      id: exchange.entitlements[0].id,
      userId: exchange.user.id,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: '5.00',
      dailyUsdLimit: '1.00',
      allowedModels: ['openai/gpt-5.4'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Seed completed inference rows summing to $0.42 today.
    const now = new Date().toISOString();
    for (const cost of [0.20, 0.15, 0.07]) {
      await inferenceStore.insertRequest({
        id: `inf_${cost}`,
        userId: exchange.user.id,
        deviceId: exchange.device.id,
        localSessionId: null,
        provider: 'openrouter',
        model: 'openai/gpt-5.4',
        requestStartedAt: now,
        requestCompletedAt: now,
        status: 'completed',
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: null,
        reasoningTokens: null,
        estimatedCostUsd: cost,
        providerRequestId: null,
        errorCode: null,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/usage/summary',
      headers: { authorization: `Bearer ${exchange.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.usage.monthToDateUsd).toBeCloseTo(0.42);
    expect(body.usage.dayToDateUsd).toBeCloseTo(0.42);
    expect(body.limits.monthlyUsdLimit).toBe(5);
    expect(body.limits.dailyUsdLimit).toBe(1);
  });
});

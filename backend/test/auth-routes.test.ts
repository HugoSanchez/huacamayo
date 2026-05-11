import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import type { PrivyAuthVerifier } from '../src/auth/types.ts';

class FakePrivyVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(accessToken: string) {
    if (accessToken !== 'privy-valid-token') {
      throw new Error('Token verification failed.');
    }

    return {
      userId: 'did:privy:user-123',
      sessionId: 'privy-session-123',
      appId: 'privy-app-id',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

const config = getConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  DATABASE_URL: '',
  PRIVY_APP_ID: 'privy-app-id',
  PRIVY_APP_SECRET: 'privy-app-secret',
  OPENROUTER_API_KEY: '',
});

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  test('exchanges a verified Privy token into an app session and returns /v1/me', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/auth/privy/exchange',
      payload: {
        privyAccessToken: 'privy-valid-token',
        deviceLabel: 'Hugo MacBook',
        platform: 'macos',
      },
    });

    expect(exchange.statusCode).toBe(200);
    const body = exchange.json();
    expect(body.user.privyUserId).toBe('did:privy:user-123');
    expect(body.session.token).toMatch(/^v1_/);
    expect(body.entitlements[0].allowedModels).toEqual(['openai/gpt-5.4']);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: `Bearer ${body.session.token}`,
      },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().device.label).toBe('Hugo MacBook');
  });

  test('returns 503 when Privy exchange is requested without Privy configuration', async () => {
    const unconfigured = getConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '8788',
    });
    const authService = new AuthService(unconfigured, new MemoryAuthStore(), null);
    app = await buildServer({ config: unconfigured, authService });

    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/auth/privy/exchange',
      payload: {
        privyAccessToken: 'privy-valid-token',
        deviceLabel: 'Vervo',
        platform: 'macos',
      },
    });

    expect(exchange.statusCode).toBe(503);
    expect(exchange.json().error).toBe('privy_unconfigured');
  });

  test('rejects exchange with missing privyAccessToken as 400 bad_request', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/auth/privy/exchange',
      payload: { deviceLabel: 'Vervo', platform: 'macos' },
    });

    expect(exchange.statusCode).toBe(400);
    expect(exchange.json().error).toBe('bad_request');
  });

  test('rejects exchange with malformed email as 400 bad_request', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const exchange = await app.inject({
      method: 'POST',
      url: '/v1/auth/privy/exchange',
      payload: {
        privyAccessToken: 'privy-valid-token',
        deviceLabel: 'Vervo',
        platform: 'macos',
        email: 'not-an-email',
      },
    });

    expect(exchange.statusCode).toBe(400);
    expect(exchange.json().error).toBe('bad_request');
  });

  test('rejects /v1/me without an Authorization header as 401 missing_session', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const me = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe('missing_session');
  });

  test('rejects /v1/me with a non-Bearer Authorization scheme as 401 invalid_session', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Basic some-token' },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe('invalid_session');
  });

  test('rejects /v1/me with an unknown bearer token as 401 invalid_session', async () => {
    const authService = new AuthService(config, new MemoryAuthStore(), new FakePrivyVerifier());
    app = await buildServer({ config, authService });

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer v1_not_a_real_token' },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe('invalid_session');
  });
});

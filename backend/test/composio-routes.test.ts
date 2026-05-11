import { afterEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.ts';
import { getConfig } from '../src/config.ts';
import { AuthService } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { ComposioService, ComposioServiceError } from '../src/composio/service.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

class StubVerifier implements PrivyAuthVerifier {
  async verifyAuthToken(_t: string): Promise<VerifiedPrivyAuthToken> {
    return {
      userId: 'did:privy:composio-test',
      sessionId: 'p-s',
      appId: 'p-a',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

/**
 * Test double for ComposioService. Captures the userId each method receives so
 * we can assert routes pass the *authenticated* user's id, not whatever the
 * client sent in the body.
 */
class StubComposioService extends ComposioService {
  capturedUserId: string | null = null;
  constructor() { super('test-key'); }

  override get configured(): boolean { return true; }

  override async getSession(userId: string) {
    this.capturedUserId = userId;
    return {
      userId,
      sessionId: 'session_x',
      mcp: { url: 'https://mcp.example/x', headers: { 'x-test': '1' } },
    };
  }

  override async listConnections(userId: string) {
    this.capturedUserId = userId;
    return [
      {
        connectedAccountId: 'ca_1',
        toolkitSlug: 'gmail',
        toolkitName: 'Gmail',
        logoUrl: null,
        status: 'active' as const,
      },
    ];
  }

  override async listToolkits(userId: string, _opts?: { query?: string; limit?: number }) {
    this.capturedUserId = userId;
    return [
      {
        slug: 'gmail',
        name: 'Gmail',
        description: null,
        logoUrl: null,
        categories: [],
        authSchemes: [],
        composioManagedAuthSchemes: [],
        connected: false,
        connectedAccountId: null,
        noAuth: false,
      },
    ];
  }

  override async executeTool(userId: string, toolSlug: string) {
    this.capturedUserId = userId;
    return { data: { ok: true, toolSlug }, error: null, logId: null };
  }

  override resetSession(_userId: string): void {
    // no-op
  }
}

const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'app',
  PRIVY_APP_SECRET: 'secret',
  OPENROUTER_API_KEY: 'or',
  COMPOSIO_API_KEY: 'composio',
};

interface Setup {
  app: Awaited<ReturnType<typeof buildServer>>;
  sessionToken: string;
  userId: string;
  composio: StubComposioService;
}

async function setup(): Promise<Setup> {
  const config = getConfig(baseEnv);
  const authStore = new MemoryAuthStore();
  const authService = new AuthService(config, authStore, new StubVerifier());
  const composio = new StubComposioService();
  const app = await buildServer({ config, authService, authStore, composioService: composio });
  const exchange = await authService.exchangePrivyAuth({
    privyAccessToken: 'privy',
    deviceLabel: 'Hugo',
    platform: 'macos',
  });
  return { app, sessionToken: exchange.sessionToken, userId: exchange.user.id, composio };
}

describe('Composio routes', () => {
  let s: Setup | null = null;
  afterEach(async () => { if (s) { await s.app.close(); s = null; } });

  test('rejects unauthenticated requests with 401', async () => {
    s = await setup();
    const res = await s.app.inject({ method: 'POST', url: '/v1/composio/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_session');
  });

  test('POST /v1/composio/session returns a session for the authenticated user', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/session',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.sessionId).toBe('session_x');
    expect(s.composio.capturedUserId).toBe(s.userId);
  });

  test('GET /v1/composio/connections returns the live list', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/connections',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0].toolkitSlug).toBe('gmail');
    expect(s.composio.capturedUserId).toBe(s.userId);
  });

  test('GET /v1/composio/toolkits passes query+limit params through', async () => {
    s = await setup();
    const composio = s.composio;
    let receivedOpts: { query?: string; limit?: number } | undefined;
    composio.listToolkits = async (userId, opts) => {
      receivedOpts = opts;
      composio.capturedUserId = userId;
      return [];
    };
    const res = await s.app.inject({
      method: 'GET',
      url: '/v1/composio/toolkits?query=gmail&limit=12',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(receivedOpts?.query).toBe('gmail');
    expect(receivedOpts?.limit).toBe(12);
  });

  test('POST /v1/composio/tools/execute ignores caller-supplied userId and uses authenticated user', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/execute',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: {
        userId: 'usr_attacker_attempting_to_act_as_someone_else',
        toolSlug: 'gmail.send',
        arguments: { to: 'a@b.com' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.data.toolSlug).toBe('gmail.send');
    // The route used the bearer's user id, not the spoofed body userId.
    expect(s.composio.capturedUserId).toBe(s.userId);
  });

  test('POST /v1/composio/tools/execute rejects missing toolSlug as 400', async () => {
    s = await setup();
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/tools/execute',
      headers: { authorization: `Bearer ${s.sessionToken}` },
      payload: { arguments: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('composio_error');
  });

  test('surfaces ComposioServiceError status when the service throws', async () => {
    s = await setup();
    s.composio.getSession = async () => {
      throw new ComposioServiceError(503, 'Composio backend is unavailable.');
    };
    const res = await s.app.inject({
      method: 'POST',
      url: '/v1/composio/session',
      headers: { authorization: `Bearer ${s.sessionToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('composio_error');
  });
});

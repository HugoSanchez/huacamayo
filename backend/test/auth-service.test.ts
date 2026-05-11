import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { AuthService, AuthServiceError } from '../src/auth/service.ts';
import { MemoryAuthStore } from '../src/auth/memory-store.ts';
import { getConfig } from '../src/config.ts';
import type { PrivyAuthVerifier, VerifiedPrivyAuthToken } from '../src/auth/types.ts';

class StubVerifier implements PrivyAuthVerifier {
  shouldThrow = false;
  thrownMessage = 'Token verification failed.';
  userId = 'did:privy:user-1';

  async verifyAuthToken(_accessToken: string): Promise<VerifiedPrivyAuthToken> {
    if (this.shouldThrow) {
      throw new Error(this.thrownMessage);
    }
    return {
      userId: this.userId,
      sessionId: 'privy-session',
      appId: 'privy-app-id',
      issuer: 'privy.io',
      issuedAt: 1_700_000_000,
      expiration: 1_700_003_600,
    };
  }
}

const baseEnv = {
  NODE_ENV: 'test' as const,
  HOST: '127.0.0.1',
  PORT: '8788',
  PRIVY_APP_ID: 'privy-app-id',
  PRIVY_APP_SECRET: 'privy-app-secret',
};

function buildService(verifier: PrivyAuthVerifier | null = new StubVerifier()) {
  const config = getConfig(baseEnv);
  const store = new MemoryAuthStore();
  return { service: new AuthService(config, store, verifier), store };
}

async function exchangeOnce(service: AuthService, overrides: Partial<{
  privyAccessToken: string;
  deviceLabel: string;
  platform: string;
  email?: string | null;
  displayName?: string | null;
}> = {}) {
  return service.exchangePrivyAuth({
    privyAccessToken: 'privy-token',
    deviceLabel: 'Hugo MacBook',
    platform: 'macos',
    ...overrides,
  });
}

describe('AuthService.exchangePrivyAuth', () => {
  let service: AuthService;
  let verifier: StubVerifier;

  beforeEach(() => {
    verifier = new StubVerifier();
    service = new AuthService(getConfig(baseEnv), new MemoryAuthStore(), verifier);
  });

  test('rejects an empty access token with 400 missing_token', async () => {
    await expect(exchangeOnce(service, { privyAccessToken: '   ' })).rejects.toMatchObject({
      status: 400,
      code: 'missing_token',
    });
  });

  test('maps Privy verifier failure to 401 invalid_privy_token', async () => {
    verifier.shouldThrow = true;
    verifier.thrownMessage = 'expired';

    const error = await exchangeOnce(service).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AuthServiceError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_privy_token' });
  });

  test('returns 503 privy_unconfigured when Privy verifier is absent', async () => {
    const unconfigured = getConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8788' });
    const noVerifier = new AuthService(unconfigured, new MemoryAuthStore(), null);

    await expect(exchangeOnce(noVerifier)).rejects.toMatchObject({
      status: 503,
      code: 'privy_unconfigured',
    });
  });

  test('persists trimmed email/displayName on first sign-in and re-uses the user on repeat', async () => {
    const first = await exchangeOnce(service, { email: '  hugo@example.com  ', displayName: '  Hugo  ' });
    expect(first.user.email).toBe('hugo@example.com');
    expect(first.user.displayName).toBe('Hugo');

    const second = await exchangeOnce(service);
    expect(second.user.id).toBe(first.user.id);
  });

  test('keeps existing email/displayName when the new exchange omits them', async () => {
    const first = await exchangeOnce(service, { email: 'hugo@example.com', displayName: 'Hugo' });
    const second = await exchangeOnce(service, { email: null, displayName: null });

    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe('hugo@example.com');
    expect(second.user.displayName).toBe('Hugo');
  });

  test('re-uses the device record for the same (userId, deviceLabel, platform) and bumps lastSeenAt', async () => {
    const first = await exchangeOnce(service);
    // Force a 1ms gap so the next ISO timestamp differs.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await exchangeOnce(service);

    expect(second.device.id).toBe(first.device.id);
    expect(Date.parse(second.device.lastSeenAt)).toBeGreaterThan(Date.parse(first.device.lastSeenAt));
  });

  test('issues a fresh session token for every exchange', async () => {
    const a = await exchangeOnce(service);
    const b = await exchangeOnce(service);
    expect(a.sessionToken).not.toBe(b.sessionToken);
  });

  test('seeds a default managed entitlement on first sign-in only', async () => {
    const first = await exchangeOnce(service);
    expect(first.entitlements).toHaveLength(1);
    expect(first.entitlements[0]).toMatchObject({ mode: 'managed', status: 'active' });

    const second = await exchangeOnce(service);
    expect(second.entitlements).toHaveLength(1);
    expect(second.entitlements[0].id).toBe(first.entitlements[0].id);
  });
});

describe('AuthService.authenticateAppSession', () => {
  test('rejects an empty session token with 401 missing_session', async () => {
    const { service } = buildService();
    await expect(service.authenticateAppSession('   ')).rejects.toMatchObject({
      status: 401,
      code: 'missing_session',
    });
  });

  test('rejects an unknown/tampered token with 401 invalid_session', async () => {
    const { service } = buildService();
    await expect(service.authenticateAppSession('v1_not_a_real_token')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_session',
    });
  });

  test('rejects an expired session with 401 expired_session', async () => {
    const { service, store } = buildService();
    const exchange = await exchangeOnce(service);

    // Backdate the session record so it is past its expiry.
    const original = await store.getAuthSessionByTokenHash(hash(exchange.sessionToken));
    expect(original).not.toBeNull();
    await store.insertAuthSession({ ...original!, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    await expect(service.authenticateAppSession(exchange.sessionToken)).rejects.toMatchObject({
      status: 401,
      code: 'expired_session',
    });
  });

  test('rejects a revoked session with 401 invalid_session', async () => {
    const { service, store } = buildService();
    const exchange = await exchangeOnce(service);

    const original = await store.getAuthSessionByTokenHash(hash(exchange.sessionToken));
    await store.insertAuthSession({ ...original!, revokedAt: new Date().toISOString() });

    await expect(service.authenticateAppSession(exchange.sessionToken)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_session',
    });
  });

  test('returns the full authenticated context on a valid session', async () => {
    const { service } = buildService();
    const exchange = await exchangeOnce(service, { email: 'hugo@example.com' });

    const auth = await service.authenticateAppSession(exchange.sessionToken);
    expect(auth.user.id).toBe(exchange.user.id);
    expect(auth.user.email).toBe('hugo@example.com');
    expect(auth.device.id).toBe(exchange.device.id);
    expect(auth.session.id).toBe(exchange.session.id);
    expect(auth.entitlements[0].mode).toBe('managed');
  });

  test('newly minted sessions use the configured lifetime', async () => {
    // Override lifetime to a small, exact value so we can compute expectations.
    const config = getConfig({ ...baseEnv, AUTH_SESSION_LIFETIME_DAYS: '10' });
    const store = new MemoryAuthStore();
    const service = new AuthService(config, store, new StubVerifier());

    const before = Date.now();
    const exchange = await exchangeOnce(service);
    const after = Date.now();

    const expiresMs = Date.parse(exchange.session.expiresAt);
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + tenDaysMs);
    expect(expiresMs).toBeLessThanOrEqual(after + tenDaysMs);
  });

  test('sliding extension: a session past the halfway mark gets refreshed to a full lifetime', async () => {
    const config = getConfig({ ...baseEnv, AUTH_SESSION_LIFETIME_DAYS: '10' });
    const store = new MemoryAuthStore();
    const service = new AuthService(config, store, new StubVerifier());

    const exchange = await exchangeOnce(service);
    const original = await store.getAuthSessionByTokenHash(hash(exchange.sessionToken));
    expect(original).not.toBeNull();

    // Backdate the session so only 2 days remain — under half the 10-day lifetime.
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    await store.extendAuthSession(original!.id, nearExpiry);

    const before = Date.now();
    const auth = await service.authenticateAppSession(exchange.sessionToken);
    const after = Date.now();

    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const extendedMs = Date.parse(auth.session.expiresAt);
    expect(extendedMs).toBeGreaterThanOrEqual(before + tenDaysMs);
    expect(extendedMs).toBeLessThanOrEqual(after + tenDaysMs);

    // Confirm it persisted to the store, not just returned.
    const persisted = await store.getAuthSessionByTokenHash(hash(exchange.sessionToken));
    expect(persisted!.expiresAt).toBe(auth.session.expiresAt);
  });

  test('sliding extension: a session well within its lifetime is left alone (no DB write)', async () => {
    const config = getConfig({ ...baseEnv, AUTH_SESSION_LIFETIME_DAYS: '10' });
    const store = new MemoryAuthStore();
    const service = new AuthService(config, store, new StubVerifier());

    const exchange = await exchangeOnce(service);
    const before = exchange.session.expiresAt;

    await service.authenticateAppSession(exchange.sessionToken);

    const after = await store.getAuthSessionByTokenHash(hash(exchange.sessionToken));
    expect(after!.expiresAt).toBe(before);
  });
});

function hash(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

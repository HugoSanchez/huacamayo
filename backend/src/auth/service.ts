import { createHash, randomBytes } from 'node:crypto';
import type { BackendConfig } from '../config.ts';
import type {
  AppUserRecord,
  AuthSessionRecord,
  AuthStore,
  AuthenticatedContext,
  DeviceRecord,
  EntitlementRecord,
  PrivyAuthVerifier,
} from './types.ts';

export class AuthServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface ExchangeAuthInput {
  privyAccessToken: string;
  deviceLabel: string;
  platform: string;
  email?: string | null;
  displayName?: string | null;
}

export interface ExchangeAuthResult {
  sessionToken: string;
  user: AppUserRecord;
  device: DeviceRecord;
  session: AuthSessionRecord;
  entitlements: EntitlementRecord[];
}

export class AuthService {
  private readonly config: BackendConfig;
  private readonly store: AuthStore;
  private readonly verifier: PrivyAuthVerifier | null;

  constructor(config: BackendConfig, store: AuthStore, verifier: PrivyAuthVerifier | null) {
    this.config = config;
    this.store = store;
    this.verifier = verifier;
  }

  async exchangePrivyAuth(input: ExchangeAuthInput): Promise<ExchangeAuthResult> {
    if (!this.config.privyConfigured || !this.verifier) {
      throw new AuthServiceError(503, 'privy_unconfigured', 'Privy is not configured.');
    }

    const accessToken = input.privyAccessToken.trim();
    if (!accessToken) {
      throw new AuthServiceError(400, 'missing_token', 'Missing Privy access token.');
    }

    const claims = await this.verifier.verifyAuthToken(accessToken).catch((error: unknown) => {
      throw new AuthServiceError(401, 'invalid_privy_token', error instanceof Error ? error.message : 'Invalid Privy access token.');
    });

    const now = new Date();
    const nowIso = now.toISOString();

    let user = await this.store.getUserByPrivyUserId(claims.userId);
    const normalizedEmail = normalizeOptionalString(input.email);
    const normalizedDisplayName = normalizeOptionalString(input.displayName);
    if (!user) {
      user = {
        id: createId('usr'),
        privyUserId: claims.userId,
        email: normalizedEmail,
        displayName: normalizedDisplayName,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await this.store.insertUser(user);
      await this.ensureDefaultManagedEntitlement(user.id, nowIso);
    } else {
      user = {
        ...user,
        email: normalizedEmail ?? user.email,
        displayName: normalizedDisplayName ?? user.displayName,
        updatedAt: nowIso,
      };
      await this.store.updateUser(user);
    }

    let device = await this.store.getDeviceByUserAndPlatform(user.id, input.deviceLabel, input.platform);
    if (!device) {
      device = {
        id: createId('dev'),
        userId: user.id,
        deviceLabel: input.deviceLabel,
        platform: input.platform,
        lastSeenAt: nowIso,
        createdAt: nowIso,
      };
      await this.store.insertDevice(device);
    } else {
      device = { ...device, lastSeenAt: nowIso };
      await this.store.updateDevice(device);
    }

    const sessionToken = createSessionToken();
    const session: AuthSessionRecord = {
      id: createId('ses'),
      userId: user.id,
      deviceId: device.id,
      tokenHash: hashSessionToken(sessionToken),
      issuedAt: nowIso,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      revokedAt: null,
    };
    await this.store.insertAuthSession(session);

    const entitlements = await this.store.listEntitlementsByUserId(user.id);
    return {
      sessionToken,
      user,
      device,
      session,
      entitlements,
    };
  }

  async authenticateAppSession(sessionToken: string): Promise<AuthenticatedContext> {
    const normalized = sessionToken.trim();
    if (!normalized) {
      throw new AuthServiceError(401, 'missing_session', 'Missing app session token.');
    }

    const tokenHash = hashSessionToken(normalized);
    const session = await this.store.getAuthSessionByTokenHash(tokenHash);
    if (!session || session.revokedAt) {
      throw new AuthServiceError(401, 'invalid_session', 'Invalid app session token.');
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new AuthServiceError(401, 'expired_session', 'App session has expired.');
    }

    const user = await this.store.getUserById(session.userId);
    const device = await this.store.getDeviceById(session.deviceId);
    if (!user || !device) {
      throw new AuthServiceError(401, 'invalid_session', 'App session is missing user or device context.');
    }

    const entitlements = await this.store.listEntitlementsByUserId(user.id);
    return { user, device, session, entitlements };
  }

  private async ensureDefaultManagedEntitlement(userId: string, nowIso: string): Promise<void> {
    const existing = await this.store.listEntitlementsByUserId(userId);
    if (existing.length > 0) return;

    await this.store.insertEntitlement({
      id: createId('ent'),
      userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: null,
      dailyUsdLimit: null,
      allowedModels: ['openai/gpt-5.4'],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

function createSessionToken(): string {
  return `v1_${randomBytes(32).toString('hex')}`;
}

function hashSessionToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

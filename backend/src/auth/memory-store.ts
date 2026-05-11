import type {
  AppUserRecord,
  AuthSessionRecord,
  AuthStore,
  DeviceRecord,
  EntitlementRecord,
} from './types.ts';

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, AppUserRecord>();
  private readonly usersByPrivyUserId = new Map<string, string>();
  private readonly devicesById = new Map<string, DeviceRecord>();
  private readonly deviceLookup = new Map<string, string>();
  private readonly sessionsById = new Map<string, AuthSessionRecord>();
  private readonly sessionsByTokenHash = new Map<string, string>();
  private readonly entitlementsById = new Map<string, EntitlementRecord>();

  async getUserByPrivyUserId(privyUserId: string): Promise<AppUserRecord | null> {
    const id = this.usersByPrivyUserId.get(privyUserId);
    return id ? this.usersById.get(id) ?? null : null;
  }

  async insertUser(user: AppUserRecord): Promise<void> {
    this.usersById.set(user.id, { ...user });
    this.usersByPrivyUserId.set(user.privyUserId, user.id);
  }

  async updateUser(user: AppUserRecord): Promise<void> {
    this.usersById.set(user.id, { ...user });
    this.usersByPrivyUserId.set(user.privyUserId, user.id);
  }

  async getDeviceByUserAndPlatform(userId: string, deviceLabel: string, platform: string): Promise<DeviceRecord | null> {
    const id = this.deviceLookup.get(deviceKey(userId, deviceLabel, platform));
    return id ? this.devicesById.get(id) ?? null : null;
  }

  async insertDevice(device: DeviceRecord): Promise<void> {
    this.devicesById.set(device.id, { ...device });
    this.deviceLookup.set(deviceKey(device.userId, device.deviceLabel, device.platform), device.id);
  }

  async updateDevice(device: DeviceRecord): Promise<void> {
    this.devicesById.set(device.id, { ...device });
    this.deviceLookup.set(deviceKey(device.userId, device.deviceLabel, device.platform), device.id);
  }

  async insertAuthSession(session: AuthSessionRecord): Promise<void> {
    this.sessionsById.set(session.id, { ...session });
    this.sessionsByTokenHash.set(session.tokenHash, session.id);
  }

  async revokeAuthSession(sessionId: string, revokedAt: string): Promise<void> {
    const existing = this.sessionsById.get(sessionId);
    if (!existing) return;
    this.sessionsById.set(sessionId, { ...existing, revokedAt });
  }

  async getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const id = this.sessionsByTokenHash.get(tokenHash);
    return id ? this.sessionsById.get(id) ?? null : null;
  }

  async getUserById(userId: string): Promise<AppUserRecord | null> {
    return this.usersById.get(userId) ?? null;
  }

  async getDeviceById(deviceId: string): Promise<DeviceRecord | null> {
    return this.devicesById.get(deviceId) ?? null;
  }

  async listEntitlementsByUserId(userId: string): Promise<EntitlementRecord[]> {
    return Array.from(this.entitlementsById.values()).filter((item) => item.userId === userId);
  }

  async insertEntitlement(entitlement: EntitlementRecord): Promise<void> {
    this.entitlementsById.set(entitlement.id, { ...entitlement });
  }
}

function deviceKey(userId: string, deviceLabel: string, platform: string): string {
  return `${userId}::${deviceLabel}::${platform}`;
}

export interface VerifiedPrivyAuthToken {
  userId: string;
  sessionId: string;
  appId: string;
  issuer: string;
  issuedAt: number;
  expiration: number;
}

export interface AppUserRecord {
  id: string;
  privyUserId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  deviceLabel: string;
  platform: string;
  lastSeenAt: string;
  createdAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface EntitlementRecord {
  id: string;
  userId: string;
  mode: string;
  status: string;
  monthlyUsdLimit: string | null;
  dailyUsdLimit: string | null;
  allowedModels: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedContext {
  user: AppUserRecord;
  device: DeviceRecord;
  session: AuthSessionRecord;
  entitlements: EntitlementRecord[];
}

export interface AuthStore {
  getUserByPrivyUserId(privyUserId: string): Promise<AppUserRecord | null>;
  insertUser(user: AppUserRecord): Promise<void>;
  updateUser(user: AppUserRecord): Promise<void>;
  getDeviceByUserAndPlatform(userId: string, deviceLabel: string, platform: string): Promise<DeviceRecord | null>;
  insertDevice(device: DeviceRecord): Promise<void>;
  updateDevice(device: DeviceRecord): Promise<void>;
  insertAuthSession(session: AuthSessionRecord): Promise<void>;
  revokeAuthSession(sessionId: string, revokedAt: string): Promise<void>;
  getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  getUserById(userId: string): Promise<AppUserRecord | null>;
  getDeviceById(deviceId: string): Promise<DeviceRecord | null>;
  listEntitlementsByUserId(userId: string): Promise<EntitlementRecord[]>;
  insertEntitlement(entitlement: EntitlementRecord): Promise<void>;
}

export interface PrivyAuthVerifier {
  verifyAuthToken(accessToken: string): Promise<VerifiedPrivyAuthToken>;
}

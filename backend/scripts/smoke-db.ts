/**
 * One-off smoke test against the live Neon DB. Inserts a test user/device/
 * session/entitlement, reads them back to verify round-trip mapping, then
 * deletes the rows so re-runs stay idempotent.
 *
 * Run with: `npm run db:smoke`
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { authSessions, devices, entitlements, users } from '../src/db/schema.ts';
import { DrizzleAuthStore } from '../src/db/auth-store.ts';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }

  const authStore = new DrizzleAuthStore(databaseUrl);
  const db = getDb(databaseUrl);

  const tag = randomBytes(4).toString('hex');
  const userId = `usr_smoke_${tag}`;
  const deviceId = `dev_smoke_${tag}`;
  const sessionId = `ses_smoke_${tag}`;
  const entitlementId = `ent_smoke_${tag}`;
  const tokenHash = `hash_smoke_${tag}`;
  const nowIso = new Date().toISOString();

  try {
    console.log('[smoke] inserting user, device, session, entitlement…');
    await authStore.insertUser({
      id: userId,
      privyUserId: `did:privy:smoke_${tag}`,
      email: 'smoke@example.com',
      displayName: 'Smoke Test',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await authStore.insertDevice({
      id: deviceId,
      userId,
      deviceLabel: 'Smoke MacBook',
      platform: 'macos',
      lastSeenAt: nowIso,
      createdAt: nowIso,
    });
    await authStore.insertAuthSession({
      id: sessionId,
      userId,
      deviceId,
      tokenHash,
      issuedAt: nowIso,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    });
    await authStore.insertEntitlement({
      id: entitlementId,
      userId,
      mode: 'managed',
      status: 'active',
      monthlyUsdLimit: null,
      dailyUsdLimit: null,
      allowedModels: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    console.log('[smoke] reading back…');
    const fetchedUser = await authStore.getUserByPrivyUserId(`did:privy:smoke_${tag}`);
    const fetchedSession = await authStore.getAuthSessionByTokenHash(tokenHash);
    const fetchedEntitlements = await authStore.listEntitlementsByUserId(userId);
    if (!fetchedUser || fetchedUser.email !== 'smoke@example.com') throw new Error('user round-trip failed');
    if (!fetchedSession || fetchedSession.id !== sessionId) throw new Error('session round-trip failed');
    if (fetchedEntitlements[0]?.mode !== 'managed') throw new Error('entitlement round-trip failed');

    console.log('[smoke] OK — all stores round-trip cleanly.');
  } finally {
    console.log('[smoke] cleaning up…');
    await db.delete(authSessions).where(eq(authSessions.id, sessionId));
    await db.delete(entitlements).where(eq(entitlements.id, entitlementId));
    await db.delete(devices).where(eq(devices.id, deviceId));
    await db.delete(users).where(eq(users.id, userId));
  }
}

main().catch((error: unknown) => {
  console.error('[smoke] failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

/**
 * One-off smoke test against the live Neon DB. Inserts a test user/device/
 * session/entitlement and an inference_request row, reads them back to verify
 * round-trip mapping, then deletes the rows so re-runs stay idempotent.
 *
 * Run with: `npm run db:smoke`
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { authSessions, devices, entitlements, inferenceRequests, users } from '../src/db/schema.ts';
import { DrizzleAuthStore } from '../src/db/auth-store.ts';
import { DrizzleInferenceStore } from '../src/db/inference-store.ts';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }

  const authStore = new DrizzleAuthStore(databaseUrl);
  const inferenceStore = new DrizzleInferenceStore(databaseUrl);
  const db = getDb(databaseUrl);

  const tag = randomBytes(4).toString('hex');
  const userId = `usr_smoke_${tag}`;
  const deviceId = `dev_smoke_${tag}`;
  const sessionId = `ses_smoke_${tag}`;
  const entitlementId = `ent_smoke_${tag}`;
  const inferenceId = `inf_smoke_${tag}`;
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
      allowedModels: ['anthropic/opus-4.7'],
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    console.log('[smoke] reading back…');
    const fetchedUser = await authStore.getUserByPrivyUserId(`did:privy:smoke_${tag}`);
    const fetchedSession = await authStore.getAuthSessionByTokenHash(tokenHash);
    const fetchedEntitlements = await authStore.listEntitlementsByUserId(userId);
    if (!fetchedUser || fetchedUser.email !== 'smoke@example.com') throw new Error('user round-trip failed');
    if (!fetchedSession || fetchedSession.id !== sessionId) throw new Error('session round-trip failed');
    if (fetchedEntitlements[0]?.allowedModels?.[0] !== 'anthropic/opus-4.7') throw new Error('entitlement round-trip failed');

    console.log('[smoke] inserting inference_request and marking completed…');
    await inferenceStore.insertRequest({
      id: inferenceId,
      userId,
      deviceId,
      localSessionId: null,
      provider: 'openrouter',
      model: 'anthropic/opus-4.7',
      requestStartedAt: nowIso,
      requestCompletedAt: null,
      status: 'pending',
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      estimatedCostUsd: null,
      providerRequestId: null,
      errorCode: null,
    });
    await inferenceStore.markCompleted(inferenceId, new Date().toISOString(), {
      inputTokens: 5,
      outputTokens: 7,
      cachedTokens: null,
      reasoningTokens: null,
      estimatedCostUsd: 0.0001,
      providerRequestId: 'gen-smoke-123',
    });

    const fetchedRequests = await inferenceStore.listByUserId(userId);
    const completed = fetchedRequests.find((r) => r.id === inferenceId);
    if (!completed || completed.status !== 'completed' || completed.inputTokens !== 5 || completed.estimatedCostUsd !== 0.0001) {
      throw new Error('inference_request round-trip failed');
    }

    console.log('[smoke] OK — all stores round-trip cleanly.');
  } finally {
    console.log('[smoke] cleaning up…');
    await db.delete(inferenceRequests).where(eq(inferenceRequests.id, inferenceId));
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

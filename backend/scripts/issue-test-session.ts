/**
 * Admin-only: mint a user + device + session row directly in the DB so we can
 * exercise authenticated paths from curl/Python clients without going through
 * Privy. Prints the bearer token to stdout.
 *
 * Run: `npm run issue-test-session`
 *
 * The created user is tagged `did:privy:test_<random>` so it never collides
 * with real users. Cleans up older test users on each run to keep the DB tidy.
 */

import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { getDb } from '../src/db/client.ts';
import { authSessions, devices, entitlements, users } from '../src/db/schema.ts';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not configured.');
    process.exit(1);
  }

  const db = getDb(databaseUrl);
  const tag = randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const userId = `usr_test_${tag}`;
  const deviceId = `dev_test_${tag}`;
  const sessionId = `ses_test_${tag}`;
  const entitlementId = `ent_test_${tag}`;
  const sessionToken = `v1_${randomBytes(32).toString('hex')}`;
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');

  // Optional cleanup: drop previous test users so we don't leave dozens behind.
  const stale = await db.select({ id: users.id }).from(users).where(like(users.privyUserId, 'did:privy:test_%'));
  for (const row of stale) {
    await db.delete(authSessions).where(eq(authSessions.userId, row.id));
    await db.delete(entitlements).where(eq(entitlements.userId, row.id));
    await db.delete(devices).where(eq(devices.userId, row.id));
    await db.delete(users).where(eq(users.id, row.id));
  }

  await db.insert(users).values({
    id: userId,
    privyUserId: `did:privy:test_${tag}`,
    email: 'test@example.com',
    displayName: 'Test User',
    createdAt: new Date(nowIso),
    updatedAt: new Date(nowIso),
  });
  await db.insert(devices).values({
    id: deviceId,
    userId,
    deviceLabel: 'Vervo for macOS (test)',
    platform: 'macos',
    lastSeenAt: new Date(nowIso),
    createdAt: new Date(nowIso),
  });
  await db.insert(authSessions).values({
    id: sessionId,
    userId,
    deviceId,
    tokenHash,
    issuedAt: new Date(nowIso),
    expiresAt: new Date(expiresAtIso),
    revokedAt: null,
  });
  await db.insert(entitlements).values({
    id: entitlementId,
    userId,
    mode: 'managed',
    status: 'active',
    monthlyUsdLimit: null,
    dailyUsdLimit: null,
    allowedModels: ['anthropic/opus-4.7', 'openai/gpt-5.4'],
    createdAt: new Date(nowIso),
    updatedAt: new Date(nowIso),
  });

  // Print just the token on stdout, everything else on stderr, so callers can
  // capture the token cleanly with `TOKEN=$(npm run --silent ... )`.
  console.error(`[issue-test-session] minted session for ${userId}, expires ${expiresAtIso}`);
  console.log(sessionToken);
}

main().catch((error: unknown) => {
  console.error('[issue-test-session] failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

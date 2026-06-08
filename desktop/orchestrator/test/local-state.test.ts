import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  applyLocalStateIsolation,
  resolveLocalState,
} from '../src/http/local-state.ts';
import { ChatStore } from '../src/http/chat-store.ts';
import { ConnectionsStore } from '../src/http/connections-store.ts';
import { startServer } from '../src/http/server.ts';

describe('local state isolation', () => {
  it('does nothing when disabled by kill switch', () => {
    const fixture = makeFixture();
    try {
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ISOLATION: '0',
        VERSO_MANAGED_USER_ID: 'usr_current',
        VERSO_LOCAL_STATE_ROOT: fixture.root,
      };

      const resolved = resolveLocalState(env, { homeDir: fixture.home });

      expect(resolved.mode).toBe('disabled');
      expect(resolved.envUpdates).toEqual({});
      expect(resolved.paths.chatStore).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('does not claim legacy state while signed out', () => {
    const fixture = makeFixture();
    try {
      writeFileSync(fixture.legacyChatStore, '', 'utf8');

      const snapshot = applyLocalStateIsolation({
        VERSO_LOCAL_STATE_ROOT: fixture.root,
      }, { homeDir: fixture.home });

      expect(snapshot.mode).toBe('signed_out');
      expect(snapshot.legacyDataDetected).toBe(true);
      expect(existsSync(fixture.ownerMarker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('claims existing legacy state for the first signed-in owner', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(fixture.legacyHermesHome, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_owner',
        VERSO_HERMES_HOME: fixture.legacyHermesHome,
      };

      const snapshot = applyLocalStateIsolation(env, {
        homeDir: fixture.home,
        now: new Date('2026-06-08T10:00:00.000Z'),
      });

      const ownerHash = hash('usr_owner');
      expect(snapshot.mode).toBe('legacy_owned');
      expect(snapshot.accountHash).toBe(ownerHash);
      expect(snapshot.legacyOwnerHash).toBe(ownerHash);
      expect(env.VERSO_CHAT_STORE_PATH).toBe(fixture.legacyChatStore);
      expect(env.VERSO_CONNECTIONS_STORE_PATH).toBe(fixture.legacyConnectionsStore);
      expect(env.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH).toBe(fixture.legacyMarker);
      expect(env.VERSO_HERMES_HOME).toBe(fixture.legacyHermesHome);
      expect(JSON.parse(readFileSync(fixture.ownerMarker, 'utf8'))).toEqual({
        version: 1,
        ownerHash,
        claimedAt: '2026-06-08T10:00:00.000Z',
      });
      expect(existsSync(path.join(fixture.legacyHermesHome, 'home'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('preserves the default Hermes profile for the first signed-in owner', () => {
    const fixture = makeFixture();
    try {
      const defaultHermesHome = path.join(fixture.home, '.hermes', 'profiles', 'verso');
      mkdirSync(defaultHermesHome, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_owner',
      };

      const snapshot = applyLocalStateIsolation(env, { homeDir: fixture.home });

      expect(snapshot.mode).toBe('legacy_owned');
      expect(snapshot.legacyDataDetected).toBe(true);
      expect(env.VERSO_HERMES_HOME).toBe(defaultHermesHome);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps the legacy paths for the recorded legacy owner', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(fixture.root, { recursive: true });
      writeOwnerMarker(fixture.ownerMarker, hash('usr_owner'));
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_owner',
        VERSO_HERMES_HOME: fixture.legacyHermesHome,
      };

      const snapshot = applyLocalStateIsolation(env, { homeDir: fixture.home });

      expect(snapshot.mode).toBe('legacy_owned');
      expect(env.VERSO_CHAT_STORE_PATH).toBe(fixture.legacyChatStore);
      expect(env.VERSO_HERMES_HOME).toBe(fixture.legacyHermesHome);
    } finally {
      fixture.cleanup();
    }
  });

  it('uses account-scoped paths for a different account on the same Mac', () => {
    const fixture = makeFixture();
    try {
      mkdirSync(fixture.root, { recursive: true });
      writeOwnerMarker(fixture.ownerMarker, hash('usr_owner'));
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_second',
        VERSO_HERMES_HOME: fixture.legacyHermesHome,
      };

      const snapshot = applyLocalStateIsolation(env, { homeDir: fixture.home });
      const accountRoot = path.join(fixture.root, 'accounts', hash('usr_second'));

      expect(snapshot.mode).toBe('account_scoped');
      expect(env.VERSO_CHAT_STORE_PATH).toBe(path.join(accountRoot, 'chat-sessions.sqlite'));
      expect(env.VERSO_CONNECTIONS_STORE_PATH).toBe(path.join(accountRoot, 'connections.json'));
      expect(env.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH).toBe(path.join(accountRoot, 'composio-tools-refresh.marker'));
      expect(env.VERSO_HERMES_HOME).toBe(path.join(accountRoot, 'hermes-home'));
      expect(existsSync(path.join(accountRoot, 'hermes-home', 'home'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('uses account-scoped paths for a fresh install', () => {
    const fixture = makeFixture();
    try {
      const env: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_fresh',
        VERSO_HERMES_HOME: fixture.legacyHermesHome,
      };

      const snapshot = applyLocalStateIsolation(env, { homeDir: fixture.home });

      expect(snapshot.mode).toBe('account_scoped');
      expect(snapshot.legacyDataDetected).toBe(false);
      expect(existsSync(fixture.ownerMarker)).toBe(false);
      expect(env.VERSO_CHAT_STORE_PATH).toContain(path.join('accounts', hash('usr_fresh')));
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps chat and connection stores isolated across account-scoped paths', () => {
    const fixture = makeFixture();
    try {
      const firstEnv: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_first',
      };
      const secondEnv: NodeJS.ProcessEnv = {
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_second',
      };
      applyLocalStateIsolation(firstEnv, { homeDir: fixture.home });
      applyLocalStateIsolation(secondEnv, { homeDir: fixture.home });

      const firstChat = new ChatStore(firstEnv.VERSO_CHAT_STORE_PATH);
      const secondChat = new ChatStore(secondEnv.VERSO_CHAT_STORE_PATH);
      const firstSession = firstChat.createSession('First account only');
      const secondSession = secondChat.createSession('Second account only');

      expect(firstChat.listSessions().map((item) => item.id)).toEqual([firstSession.id]);
      expect(secondChat.listSessions().map((item) => item.id)).toEqual([secondSession.id]);
      expect(firstChat.listSessions()[0].title).toBe('First account only');
      expect(secondChat.listSessions()[0].title).toBe('Second account only');

      const firstConnections = new ConnectionsStore(
        firstEnv.VERSO_CONNECTIONS_STORE_PATH,
        firstEnv.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH,
      );
      const secondConnections = new ConnectionsStore(
        secondEnv.VERSO_CONNECTIONS_STORE_PATH,
        secondEnv.VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH,
      );
      firstConnections.upsertConnection({
        connectedAccountId: 'ca_first',
        toolkitSlug: 'gmail',
        toolkitName: 'Gmail',
        logoUrl: null,
        status: 'active',
        createdAt: '2026-06-08T10:00:00.000Z',
        updatedAt: '2026-06-08T10:00:00.000Z',
      });

      expect(firstConnections.listConnections()).toHaveLength(1);
      expect(secondConnections.listConnections()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('surfaces the active local-state paths in diagnostics', async () => {
    const fixture = makeFixture();
    const envSnapshot = snapshotProcessEnv([
      'VERSO_HERMES_MANAGED',
      'VERSO_LOCAL_STATE_ROOT',
      'VERSO_MANAGED_USER_ID',
      'VERSO_CHAT_STORE_PATH',
      'VERSO_CONNECTIONS_STORE_PATH',
      'VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH',
      'VERSO_HERMES_HOME',
      'VERSO_LEGACY_CHAT_STORE_PATH',
      'VERSO_LEGACY_CONNECTIONS_STORE_PATH',
      'VERSO_LEGACY_COMPOSIO_TOOLS_REFRESH_MARKER_PATH',
      'VERSO_LEGACY_HERMES_HOME',
    ]);
    let result: Awaited<ReturnType<typeof startServer>> | null = null;

    try {
      result = await withProcessEnv({
        VERSO_HERMES_MANAGED: 'false',
        VERSO_LOCAL_STATE_ROOT: fixture.root,
        VERSO_MANAGED_USER_ID: 'usr_diagnostics',
        VERSO_HERMES_HOME: fixture.legacyHermesHome,
        VERSO_CHAT_STORE_PATH: undefined,
        VERSO_CONNECTIONS_STORE_PATH: undefined,
        VERSO_COMPOSIO_TOOLS_REFRESH_MARKER_PATH: undefined,
        VERSO_LEGACY_CHAT_STORE_PATH: path.join(fixture.tempDir, 'missing-chat.sqlite'),
        VERSO_LEGACY_CONNECTIONS_STORE_PATH: path.join(fixture.tempDir, 'missing-connections.json'),
        VERSO_LEGACY_COMPOSIO_TOOLS_REFRESH_MARKER_PATH: path.join(fixture.tempDir, 'missing-marker'),
        VERSO_LEGACY_HERMES_HOME: path.join(fixture.tempDir, 'missing-hermes-home'),
      }, async () => startServer({ port: 0 }));

      const res = await fetch(`http://127.0.0.1:${result.port}/diagnostics`);
      const body = await res.json() as {
        chat: { storePath: string };
        localState: {
          mode: string;
          accountHash: string;
          paths: {
            chatStore: string;
            connectionsStore: string;
            composioToolsRefreshMarker: string;
            hermesHome: string;
          };
        };
      };
      const accountHash = hash('usr_diagnostics');
      const accountRoot = path.join(fixture.root, 'accounts', accountHash);

      expect(body.localState.mode).toBe('account_scoped');
      expect(body.localState.accountHash).toBe(accountHash);
      expect(body.localState.paths.chatStore).toBe(path.join(accountRoot, 'chat-sessions.sqlite'));
      expect(body.localState.paths.connectionsStore).toBe(path.join(accountRoot, 'connections.json'));
      expect(body.localState.paths.composioToolsRefreshMarker).toBe(path.join(accountRoot, 'composio-tools-refresh.marker'));
      expect(body.localState.paths.hermesHome).toBe(path.join(accountRoot, 'hermes-home'));
      expect(body.chat.storePath).toBe(body.localState.paths.chatStore);
    } finally {
      await result?.close();
      restoreProcessEnv(envSnapshot);
      fixture.cleanup();
    }
  });
});

function makeFixture(): {
  tempDir: string;
  home: string;
  root: string;
  ownerMarker: string;
  legacyChatStore: string;
  legacyConnectionsStore: string;
  legacyMarker: string;
  legacyHermesHome: string;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-local-state-'));
  const home = path.join(tempDir, 'home');
  const root = path.join(tempDir, 'app-support', 'Verso');
  const legacyRoot = path.join(home, 'Library', 'Application Support', 'verso');
  mkdirSync(legacyRoot, { recursive: true });

  return {
    tempDir,
    home,
    root,
    ownerMarker: path.join(root, 'local-state-owner.json'),
    legacyChatStore: path.join(legacyRoot, 'chat-sessions.sqlite'),
    legacyConnectionsStore: path.join(legacyRoot, 'connections.json'),
    legacyMarker: path.join(legacyRoot, 'composio-tools-refresh.marker'),
    legacyHermesHome: path.join(root, 'hermes-home'),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function writeOwnerMarker(markerPath: string, ownerHash: string): void {
  writeFileSync(markerPath, JSON.stringify({
    version: 1,
    ownerHash,
    claimedAt: '2026-06-08T09:00:00.000Z',
  }), 'utf8');
}

function hash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

function snapshotProcessEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withProcessEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn();
}

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsStore, type ConnectionRecord } from '../src/http/connections-store.ts';
import { ManagedBackendClient } from '../src/integrations/managed-backend-client.ts';
import { ConnectionsService } from '../src/integrations/composio.ts';

function fixtureConnection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectedAccountId: 'ca_123',
    toolkitSlug: 'slack',
    toolkitName: 'Slack',
    logoUrl: 'https://example.com/slack.png',
    status: 'active',
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    ...overrides,
  };
}

function setupService(): { service: ConnectionsService; store: ConnectionsStore } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verso-connections-service-'));
  const store = new ConnectionsStore(
    path.join(tempDir, 'connections.json'),
    path.join(tempDir, 'composio-tools-refresh.marker'),
  );
  const managedBackend = new ManagedBackendClient('https://backend.example.test');
  managedBackend.setSession({
    token: 'token-test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    userId: 'usr_test',
    email: null,
    displayName: null,
    receivedAt: new Date().toISOString(),
  });
  return { service: new ConnectionsService(managedBackend, store), store };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ConnectionsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes stale local connections after a successful empty remote list', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ connections: [] }));

    await expect(service.listConnections()).resolves.toEqual([]);

    expect(store.listConnections()).toEqual([]);
  });

  it('treats backend 404 on delete as already disconnected locally', async () => {
    const { service, store } = setupService();
    store.upsertConnection(fixtureConnection());
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'not found' }, 404));

    await expect(service.deleteConnection('ca_123')).resolves.toBeUndefined();

    expect(store.listConnections()).toEqual([]);
  });
});

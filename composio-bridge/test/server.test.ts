import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/server.ts';

describe('Composio bridge backend', () => {
  let server: http.Server | null = null;
  let port = 0;
  const envSnapshot = {
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
    VERVO_COMPOSIO_BRIDGE_TOKEN: process.env.VERVO_COMPOSIO_BRIDGE_TOKEN,
  };

  beforeAll(async () => {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.VERVO_COMPOSIO_BRIDGE_TOKEN;
    const result = await startServer({ port: 0 });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      server = null;
    }
    process.env.COMPOSIO_API_KEY = envSnapshot.COMPOSIO_API_KEY;
    process.env.VERVO_COMPOSIO_BRIDGE_TOKEN = envSnapshot.VERVO_COMPOSIO_BRIDGE_TOKEN;
  });

  async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  it('reports unavailable session creation without a Composio API key', async () => {
    const { status, body } = await fetchJson('/v1/composio/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-123' }),
    });

    expect(status).toBe(503);
    expect(body.error).toBe('request_failed');
    expect(body.message).toContain('COMPOSIO_API_KEY');
  });
});

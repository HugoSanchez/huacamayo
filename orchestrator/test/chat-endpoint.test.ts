import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/http/server.ts';

describe('Chat HTTP Endpoints', () => {
  let server: http.Server | null = null;
  let port = 0;
  const envSnapshot = {
    VERVO_HERMES_MANAGED: process.env.VERVO_HERMES_MANAGED,
    VERVO_CHAT_STORE_PATH: process.env.VERVO_CHAT_STORE_PATH,
  };

  beforeAll(async () => {
    process.env.VERVO_HERMES_MANAGED = 'false';
    process.env.VERVO_CHAT_STORE_PATH = `/tmp/vervo-chat-endpoint-${process.pid}.json`;
    const result = await startServer({ port: 0 });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      server = null;
    }
    process.env.VERVO_HERMES_MANAGED = envSnapshot.VERVO_HERMES_MANAGED;
    process.env.VERVO_CHAT_STORE_PATH = envSnapshot.VERVO_CHAT_STORE_PATH;
  });

  function url(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(path), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  it('reports Hermes chat status', async () => {
    const { status, body } = await fetchJson('/chat/status');
    expect(status).toBe(200);
    expect(body.status).toBe('idle');
    expect(body.provider).toBe('hermes');
    expect(body.hasActiveRequest).toBe(false);
  });

  it('creates and reads a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inflation thread' }),
    });

    expect(created.status).toBe(201);
    expect(created.body.session.title).toBe('Inflation thread');

    const sessionId = created.body.session.id as string;

    const fetched = await fetchJson(`/chat/sessions/${sessionId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.session.id).toBe(sessionId);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toEqual([]);
  });

  it('rejects missing message content', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetchJson(`/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });
});

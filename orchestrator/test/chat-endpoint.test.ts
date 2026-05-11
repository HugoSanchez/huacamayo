import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/http/server.ts';

describe('Chat HTTP Endpoints', () => {
  let server: http.Server | null = null;
  let port = 0;
  const envSnapshot = {
    VERVO_HERMES_MANAGED: process.env.VERVO_HERMES_MANAGED,
    VERVO_CHAT_STORE_PATH: process.env.VERVO_CHAT_STORE_PATH,
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
  };

  beforeAll(async () => {
    process.env.VERVO_HERMES_MANAGED = 'false';
    process.env.VERVO_CHAT_STORE_PATH = `/tmp/vervo-chat-endpoint-${process.pid}.sqlite`;
    delete process.env.COMPOSIO_API_KEY;
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
    process.env.COMPOSIO_API_KEY = envSnapshot.COMPOSIO_API_KEY;
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

  it('reports composio bridge as unauthenticated when no managed session is loaded', async () => {
    const { status, body } = await fetchJson('/composio/session');
    expect(status).toBe(401);
    expect(body.error).toBe('request_failed');
    expect(body.message).toMatch(/session/i);
  });

  it('creates and reads a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inflation thread' }),
    });

    expect(created.status).toBe(201);
    expect(created.body.session.title).toBe('Inflation thread');
    expect(created.body.session.archivedAt).toBeNull();

    const sessionId = created.body.session.id as string;

    const fetched = await fetchJson(`/chat/sessions/${sessionId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.session.id).toBe(sessionId);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toEqual([]);
  });

  it('archives and restores a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Archive me' }),
    });

    const sessionId = created.body.session.id as string;

    const archived = await fetchJson(`/chat/sessions/${sessionId}/archive`, {
      method: 'POST',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.session.archivedAt).toEqual(expect.any(String));

    const restored = await fetchJson(`/chat/sessions/${sessionId}/unarchive`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(restored.body.session.archivedAt).toBeNull();
  });

  it('renames a session', async () => {
    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Draft title' }),
    });

    const sessionId = created.body.session.id as string;

    const renamed = await fetchJson(`/chat/sessions/${sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed session' }),
    });

    expect(renamed.status).toBe(200);
    expect(renamed.body.session.title).toBe('Renamed session');
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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/http/server.ts';

/**
 * End-to-end coverage for VERSO_AGENT_BACKEND=centaur: a mock api-rs stands in
 * for the Lightsail instance, and we assert the orchestrator drives the
 * create → messages → execute → SSE flow and translates events into chat-ui
 * frames, without Hermes ever being spawned.
 */
describe('Centaur backend chat', () => {
  let mock: http.Server | null = null;
  let mockPort = 0;
  let server: http.Server | null = null;
  let port = 0;
  const calls: string[] = [];
  const executeBodies: string[] = [];
  const createSessionBodies: string[] = [];
  const messageBodies: string[] = [];

  const envKeys = [
    'VERSO_AGENT_BACKEND',
    'VERSO_CENTAUR_URL',
    'VERSO_CENTAUR_API_KEY',
    'VERSO_CENTAUR_HARNESS',
    'VERSO_CENTAUR_COMPOSIO_USER_ID',
    'VERSO_CHAT_STORE_PATH',
    'VERSO_CENTAUR_STORE_PATH',
    'VERSO_HERMES_MANAGED',
  ] as const;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of envKeys) envSnapshot[key] = process.env[key];

    mock = http.createServer((req, res) => {
      const { method, url = '' } = req;
      calls.push(`${method} ${decodeURIComponent(url.split('?')[0])}`);

      if (url === '/healthz') return sendJson(res, { ok: true });
      if (url === '/readyz') return sendJson(res, { ok: true, ready: true });

      if (url.endsWith('/execute')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          executeBodies.push(body);
          sendJson(res, { ok: true, execution_id: 'exec-1', thread_key: 'verso:x', status: 'queued' });
        });
        return;
      }
      if (url.endsWith('/messages')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          messageBodies.push(body);
          sendJson(res, { ok: true, message_ids: ['m1'] });
        });
        return;
      }
      if (url.includes('/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse(1, 'session.execution_started', { execution_id: 'exec-1' }));
        res.write(sse(2, 'session.sandbox_ready', { sandbox_ready_source: 'reused', execution_id: 'exec-1' }));
        res.write(sse(3, 'session.output.line', JSON.stringify({
          method: 'item/agentMessage/delta', params: { itemId: 'i1', delta: 'Hello ' },
        })));
        res.write(sse(4, 'session.output.line', JSON.stringify({
          method: 'item/agentMessage/delta', params: { itemId: 'i1', delta: 'from Centaur' },
        })));
        res.write(sse(5, 'session.execution_completed', {
          execution_id: 'exec-1', result_text: 'Hello from Centaur',
        }));
        return res.end();
      }
      // create-or-get session
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        createSessionBodies.push(body);
        sendJson(res, { thread_key: 'verso:x', harness_type: 'claudecode', status: 'active', harness_switched: false });
      });
      return;
    });
    mockPort = await listen(mock);

    process.env.VERSO_AGENT_BACKEND = 'centaur';
    process.env.VERSO_CENTAUR_URL = `http://127.0.0.1:${mockPort}`;
    process.env.VERSO_CENTAUR_HARNESS = 'codex';
    process.env.VERSO_CENTAUR_COMPOSIO_USER_ID = 'usr_test123';
    delete process.env.VERSO_CENTAUR_API_KEY;
    process.env.VERSO_HERMES_MANAGED = 'false';
    process.env.VERSO_CHAT_STORE_PATH = `/tmp/verso-centaur-chat-${process.pid}.sqlite`;
    process.env.VERSO_CENTAUR_STORE_PATH = `/tmp/verso-centaur-threads-${process.pid}.sqlite`;

    const result = await startServer({ port: 0 });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (mock) await new Promise<void>((r) => mock!.close(() => r()));
    for (const key of envKeys) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  function url(pathname: string): string {
    return `http://127.0.0.1:${port}${pathname}`;
  }

  it('reports centaur status backed by the readyz probe', async () => {
    const res = await fetch(url('/chat/status'));
    const body = await res.json();
    expect(body.provider).toBe('centaur');
    expect(body.gateway.reachable).toBe(true);
    expect(body.gateway.url).toBe(`http://127.0.0.1:${mockPort}`);
  });

  it('runs a turn end to end and stores the assistant reply', async () => {
    const created = await fetch(url('/chat/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const sessionId = created.session.id as string;

    const res = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'ping',
        harnessType: 'codex',
        model: 'gpt-5.5',
        provider: 'openai',
      }),
    });
    expect(res.status).toBe(200);
    const stream = await res.text();

    // Incremental deltas + a terminal done frame.
    expect(stream).toContain('content_block_delta');
    expect(stream).toContain('Hello ');
    expect(stream).toContain('from Centaur');
    expect(stream).toContain('"provider":"centaur"');
    expect(stream).toContain('"type":"done"');

    // The orchestrator drove the full RFC-0002 flow.
    expect(calls).toContain('POST /api/session/verso:' + sessionId);
    expect(calls).toContain('POST /api/session/verso:' + sessionId + '/messages');
    expect(calls).toContain('POST /api/session/verso:' + sessionId + '/execute');
    expect(calls).toContain('GET /api/session/verso:' + sessionId + '/events');
    expect(calls.some((call) => call.includes('/agent/'))).toBe(false);

    const firstCreate = JSON.parse(createSessionBodies[0]) as Record<string, unknown>;
    expect(firstCreate).toMatchObject({
      harness_type: 'codex',
      persona_id: null,
      metadata: { source: 'verso' },
      on_harness_conflict: 'restart',
    });

    // Assistant reply persisted to the local ChatStore.
    const messages = await fetch(url(`/chat/sessions/${sessionId}/messages`)).then((r) => r.json());
    const assistant = messages.messages.find((m: any) => m.role === 'assistant');
    expect(assistant?.content).toBe('Hello from Centaur');

    // First message carries the environment preamble (Composio guidance +
    // entity id) on the OUTBOUND copy only — never in the local store.
    expect(executeBodies.length).toBe(1);
    expect(executeBodies[0]).toContain('centaur_tool_composio.client');
    expect(executeBodies[0]).toContain('usr_test123');
    const firstMessage = JSON.parse(messageBodies[0]) as { messages: Array<{ client_message_id: string }> };
    const firstExecute = JSON.parse(executeBodies[0]) as {
      idempotency_key: string;
      input_lines: string[];
      model?: string;
      provider?: string;
    };
    expect(firstMessage.messages[0].client_message_id).toBe(firstExecute.idempotency_key);
    expect(firstExecute.model).toBeUndefined();
    expect(firstExecute.provider).toBeUndefined();
    expect(JSON.parse(firstExecute.input_lines[0])).toMatchObject({
      type: 'user',
      thread_key: `verso:${sessionId}`,
      model: 'gpt-5.5',
      provider: 'openai',
    });
    const user = messages.messages.find((m: any) => m.role === 'user');
    expect(user?.content).toBe('ping');

    // Second turn: no preamble.
    const res2 = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'ping again' }),
    });
    expect(res2.status).toBe(200);
    await res2.text();
    expect(executeBodies.length).toBe(2);
    // Non-first turns carry the compact reminder, not the full preamble.
    expect(executeBodies[1]).not.toContain('centaur_tool_composio.client');
    expect(executeBodies[1]).toContain('verso-reminder');
    expect(executeBodies[1]).toContain('usr_test123');
    // idle_timeout doubles as the sandbox pause timer — must be the long value.
    expect(executeBodies[0]).toContain('"idle_timeout_ms":300000');
  });

  it('honors claudecode and amp selections in the session API payloads', async () => {
    const createdClaude = await fetch(url('/chat/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const claudeSessionId = createdClaude.session.id as string;

    const startCreateCount = createSessionBodies.length;
    const startExecuteCount = executeBodies.length;
    const claudeRes = await fetch(url(`/chat/sessions/${claudeSessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'claude ping',
        harnessType: 'claudecode',
        model: 'claude-sonnet-4-6[1m]',
        provider: 'anthropic',
      }),
    });
    expect(claudeRes.status).toBe(200);
    await claudeRes.text();

    expect(JSON.parse(createSessionBodies[startCreateCount])).toMatchObject({
      harness_type: 'claudecode',
      on_harness_conflict: 'restart',
    });
    expect(JSON.parse(JSON.parse(executeBodies[startExecuteCount]).input_lines[0])).toMatchObject({
      thread_key: `verso:${claudeSessionId}`,
      model: 'claude-sonnet-4-6[1m]',
      provider: 'anthropic',
    });

    const createdAmp = await fetch(url('/chat/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const ampSessionId = createdAmp.session.id as string;

    const ampCreateIndex = createSessionBodies.length;
    const ampExecuteIndex = executeBodies.length;
    const ampRes = await fetch(url(`/chat/sessions/${ampSessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'amp ping',
        harnessType: 'amp',
        model: 'deep',
        provider: 'amp',
      }),
    });
    expect(ampRes.status).toBe(200);
    await ampRes.text();

    expect(JSON.parse(createSessionBodies[ampCreateIndex])).toMatchObject({
      harness_type: 'amp',
      on_harness_conflict: 'restart',
    });
    expect(JSON.parse(JSON.parse(executeBodies[ampExecuteIndex]).input_lines[0])).toMatchObject({
      thread_key: `verso:${ampSessionId}`,
      model: 'deep',
      provider: 'amp',
    });
  });
});

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sse(id: number, event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `id: ${id}\nevent: ${event}\ndata: ${payload}\n\n`;
}

function listen(srv: http.Server): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

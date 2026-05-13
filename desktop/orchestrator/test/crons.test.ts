import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/http/server.ts';

describe('Crons orchestrator routes', () => {
  let server: http.Server | null = null;
  let port = 0;
  let gatewayPort = 0;
  let envSnapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    envSnapshot = {
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
      VERSO_HERMES_COMMAND: process.env.VERSO_HERMES_COMMAND,
      VERSO_HERMES_ARGS: process.env.VERSO_HERMES_ARGS,
      VERSO_HERMES_CWD: process.env.VERSO_HERMES_CWD,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
    };

    gatewayPort = await allocatePort();
    process.env.VERSO_HERMES_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    process.env.VERSO_CHAT_STORE_PATH = `/tmp/verso-crons-${process.pid}.sqlite`;
    process.env.VERSO_HERMES_COMMAND = process.execPath;
    process.env.VERSO_HERMES_ARGS = JSON.stringify([
      path.resolve(process.cwd(), 'test/fixtures/fake-hermes-gateway.mjs'),
    ]);
    process.env.VERSO_HERMES_CWD = process.cwd();
    process.env.VERSO_HERMES_MANAGED = 'true';

    const result = await startServer({ port: 0 });
    server = result.server;
    port = result.port;

    // The Hermes gateway boots lazily on the first request that calls
    // ensureReady — kick it once so direct gateway calls in test bodies
    // don't race the boot.
    await fetch(`http://127.0.0.1:${port}/chat/status`);
    await waitFor(`http://127.0.0.1:${gatewayPort}/health`, 5000);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function url(pathname: string): string {
    return `http://127.0.0.1:${port}${pathname}`;
  }

  function gatewayUrl(pathname: string): string {
    return `http://127.0.0.1:${gatewayPort}${pathname}`;
  }

  async function createJobOnGateway(payload: Record<string, unknown> = {}): Promise<string> {
    // Drive the fake gateway's POST /api/jobs directly so we don't depend on
    // an orchestrator-side create endpoint we deliberately haven't exposed
    // (Phase 1 is read+modify only; chat-side creation comes later).
    const res = await fetch(gatewayUrl('/api/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-job',
        schedule: 'every 30m',
        prompt: 'Do the thing',
        ...payload,
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { job: { id: string } };
    return body.job.id;
  }

  it('lists jobs from Hermes', async () => {
    const id = await createJobOnGateway({ name: 'list-target' });
    const res = await fetch(url('/crons'));
    expect(res.status).toBe(200);
    const body = await res.json() as { crons: Array<{ id: string; name: string }> };
    expect(body.crons.some((j) => j.id === id && j.name === 'list-target')).toBe(true);
  });

  it('returns a single job with empty runs when no output dir', async () => {
    const id = await createJobOnGateway({ name: 'detail-target' });
    const res = await fetch(url(`/crons/${id}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { cron: { id: string }; runs: unknown[] };
    expect(body.cron.id).toBe(id);
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('rejects non-hex job ids on detail (path-traversal guard)', async () => {
    const res = await fetch(url('/crons/..%2F..%2Fetc%2Fpasswd'));
    expect(res.status).toBe(404);
  });

  it('rejects bad run filenames', async () => {
    const id = await createJobOnGateway();
    const res = await fetch(url(`/crons/${id}/runs/..%2Fpasswd`));
    expect(res.status).toBe(400);
  });

  it('patches a job', async () => {
    const id = await createJobOnGateway({ name: 'before' });
    const res = await fetch(url(`/crons/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'after', prompt: 'changed', schedule: 'every 2h' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { cron: { name: string; prompt: string; schedule_display: string } };
    expect(body.cron.name).toBe('after');
    expect(body.cron.prompt).toBe('changed');
    expect(body.cron.schedule_display).toBe('every 2h');
  });

  it('strips unknown fields on patch', async () => {
    const id = await createJobOnGateway({ name: 'sanitize-target' });
    const res = await fetch(url(`/crons/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'kept', evil: { rm: '-rf /' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { cron: Record<string, unknown> };
    expect(body.cron.name).toBe('kept');
    expect((body.cron as Record<string, unknown>).evil).toBeUndefined();
  });

  it('pauses, resumes, and runs a job', async () => {
    const id = await createJobOnGateway({ name: 'lifecycle' });

    let res = await fetch(url(`/crons/${id}/pause`), { method: 'POST' });
    expect(res.status).toBe(200);
    let body = await res.json() as { cron: { state: string } };
    expect(body.cron.state).toBe('paused');

    res = await fetch(url(`/crons/${id}/resume`), { method: 'POST' });
    expect(res.status).toBe(200);
    body = await res.json() as { cron: { state: string } };
    expect(body.cron.state).toBe('scheduled');

    res = await fetch(url(`/crons/${id}/run`), { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('deletes a job', async () => {
    const id = await createJobOnGateway({ name: 'doomed' });
    const res = await fetch(url(`/crons/${id}`), { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const followup = await fetch(url(`/crons/${id}`));
    expect(followup.status).toBe(404);
  });
});

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function allocatePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

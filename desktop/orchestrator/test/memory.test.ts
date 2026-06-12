import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { GBrainRuntimeConfig } from '../src/http/gbrain.ts';
import { buildMemoryRoutes, GBrainMemoryRuntime } from '../src/http/memory.ts';
import type { Route } from '../src/http/router.ts';

let tempRoot = '';

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-memory-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * A fake `gbrain serve`: a real child process speaking MCP over stdio
 * (newline-delimited JSON-RPC), with canned per-tool responses.
 */
function writeFakeGBrainServe(opts: { exitImmediately?: boolean } = {}): string {
  const script = path.join(tempRoot, 'fake-gbrain-serve.mjs');
  writeFileSync(script, [
    "import readline from 'node:readline';",
    `if (${opts.exitImmediately ? 'true' : 'false'}) process.exit(3);`,
    'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
    'const reply = (id, payload) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });',
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    '  let msg; try { msg = JSON.parse(line); } catch { return; }',
    "  if (msg.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-gbrain', version: '0.0.0' } } });",
    "  } else if (msg.method === 'tools/call') {",
    '    const name = msg.params?.name;',
    '    const args = msg.params?.arguments ?? {};',
    "    if (name === 'search' && args.query === 'EXPLODE') {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'search backend exploded' }], isError: true } });",
    "    } else if (name === 'search') {",
    "      reply(msg.id, { results: [{ slug: 'companies/acme', title: 'Acme', score: 0.91239876, chunk_text: 'x'.repeat(2000), internal_ranking_state: 'do-not-leak' }] });",
    "    } else if (name === 'get_page') {",
    "      reply(msg.id, { slug: args.slug, content: 'y'.repeat(30000) });",
    "    } else if (name === 'boom') {",
    "      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'tool exploded' }], isError: true } });",
    '    } else {',
    '      reply(msg.id, { ok: true, tool: name, args });',
    '    }',
    '  }',
    '});',
  ].join('\n'), 'utf8');

  const wrapper = path.join(tempRoot, 'fake-gbrain-serve.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function runtimeConfig(overrides: Partial<GBrainRuntimeConfig> = {}): GBrainRuntimeConfig {
  return {
    enabled: true,
    home: path.join(tempRoot, 'gbrain-home'),
    command: null,
    argsPrefix: [],
    reason: null,
    embedding: {
      enabled: true,
      modelId: 'embeddinggemma-300m',
      modelUrl: 'https://example.com/model.gguf',
      modelPath: path.join(tempRoot, 'models', 'model.gguf'),
      dimensions: 768,
      port: 17872,
      baseUrl: 'http://127.0.0.1:17872/v1',
      command: null,
      reason: null,
    },
    ...overrides,
  };
}

interface FakeResponse {
  status: number | null;
  body: unknown;
}

function fakeRes(): { res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = { status: null, body: null };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: string) {
      out.body = body ? JSON.parse(body) : null;
    },
    setHeader() { /* noop */ },
  } as unknown as ServerResponse;
  return { res, out };
}

function findRoute(routes: Route[], method: string, routePath: string): Route {
  const match = routes.find((r) => r.method === method && r.pattern.test(routePath));
  if (!match) throw new Error(`No route for ${method} ${routePath}`);
  return match;
}

async function callRoute(routes: Route[], method: string, routePath: string, body: unknown): Promise<FakeResponse> {
  const matched = findRoute(routes, method, routePath);
  const { res, out } = fakeRes();
  await matched.handler({} as never, res, {}, body);
  return out;
}

describe('GBrainMemoryRuntime', () => {
  let runtime: GBrainMemoryRuntime | null = null;

  afterEach(async () => {
    await runtime?.stop();
    runtime = null;
  });

  it('is disabled when GBrain is disabled', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ enabled: false, command: '/bin/echo' }));
    await runtime.start();
    expect(runtime.getState()).toBe('disabled');
  });

  it('is unavailable when the gbrain command is missing', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: null, reason: 'GBrain command not found.' }));
    await runtime.start();
    expect(runtime.getState()).toBe('unavailable');
    expect(runtime.diagnostics().lastError).toContain('GBrain command not found');
  });

  it('runs prepare before spawning, handshakes, and becomes ready', async () => {
    const order: string[] = [];
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }), {
      prepare: () => {
        order.push('prepare');
        expect(runtime!.isReady()).toBe(false);
      },
    });

    await runtime.start();

    expect(order).toEqual(['prepare']);
    expect(runtime.getState()).toBe('ready');
    expect(runtime.diagnostics().pid).toBeGreaterThan(0);
  });

  it('start is idempotent while a start is in flight', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await Promise.all([runtime.start(), runtime.start()]);
    expect(runtime.getState()).toBe('ready');
  });

  it('calls tools and parses JSON text content', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await runtime.start();

    const result = await runtime.callTool('search', { query: 'acme' }) as { results: Array<{ slug: string }> };
    expect(result.results[0].slug).toBe('companies/acme');
  });

  it('propagates tool errors as rejections', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await runtime.start();

    await expect(runtime.callTool('boom', {})).rejects.toThrow('tool exploded');
  });

  it('rejects tool calls when not ready', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await expect(runtime.callTool('search', { query: 'x' })).rejects.toThrow('not available');
  });

  it('lands in error state when the serve child keeps dying', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe({ exitImmediately: true }) }), {
      initTimeoutMs: 2_000,
      restartDelayMs: 10,
      maxRestarts: 1,
    });
    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const diagnostics = runtime.diagnostics();
    expect(diagnostics.state).toBe('error');
    expect(diagnostics.restarts).toBe(1);
    expect(diagnostics.lastError).toContain('gbrain serve exited');
  });

  it('stops cleanly', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await runtime.start();
    expect(runtime.isReady()).toBe(true);

    await runtime.stop();
    expect(runtime.isReady()).toBe(false);
    expect(runtime.getState()).toBe('idle');
  });
});

describe('memory routes', () => {
  let runtime: GBrainMemoryRuntime | null = null;

  afterEach(async () => {
    await runtime?.stop();
    runtime = null;
  });

  async function readyRoutes(): Promise<Route[]> {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    await runtime.start();
    return buildMemoryRoutes(runtime);
  }

  it('GET /memory/status reports diagnostics', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'GET', '/memory/status', null);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, state: 'ready', enabled: true });
  });

  it('POST /memory/search trims rows to a compact whitelisted shape', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/search', { query: 'acme' });

    expect(out.status).toBe(200);
    const body = out.body as { ok: boolean; results: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(1);
    const row = body.results[0];
    expect(row.slug).toBe('companies/acme');
    expect(row.title).toBe('Acme');
    expect(row.score).toBe(0.9124);
    expect((row.snippet as string).length).toBeLessThanOrEqual(700 + '…[truncated]'.length);
    expect((row.snippet as string).endsWith('…[truncated]')).toBe(true);
    expect(row).not.toHaveProperty('chunk_text');
    expect(row).not.toHaveProperty('internal_ranking_state');
  });

  it('POST /memory/search validates the query', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/search', { limit: 3 });

    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ ok: false, error: 'invalid_request' });
  });

  it('POST /memory/page truncates oversized page content', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/page', { slug: 'companies/acme' });

    expect(out.status).toBe(200);
    const page = (out.body as { page: { slug: string; content: string } }).page;
    expect(page.slug).toBe('companies/acme');
    expect(page.content.length).toBeLessThanOrEqual(20_000 + '…[truncated]'.length);
    expect(page.content.endsWith('…[truncated]')).toBe(true);
  });

  it('POST /memory/write-page forwards slug and content', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/write-page', {
      slug: 'people/jane-doe',
      content: '# Jane Doe\n\nMet at the conference.',
    });

    expect(out.status).toBe(200);
    const result = (out.body as { result: { tool: string; args: Record<string, unknown> } }).result;
    expect(result.tool).toBe('put_page');
    expect(result.args).toMatchObject({ slug: 'people/jane-doe' });
  });

  it('POST /memory/write-page rejects missing fields', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/write-page', { slug: 'people/jane-doe' });
    expect(out.status).toBe(400);
  });

  it('POST /memory/link maps to add_link with optional fields', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/link', {
      from: 'meetings/2026-06-10',
      to: 'people/jane-doe',
      link_type: 'mentions',
    });

    expect(out.status).toBe(200);
    const result = (out.body as { result: { tool: string; args: Record<string, unknown> } }).result;
    expect(result.tool).toBe('add_link');
    expect(result.args).toEqual({ from: 'meetings/2026-06-10', to: 'people/jane-doe', link_type: 'mentions' });
  });

  it('POST /memory/timeline maps to add_timeline_entry', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/timeline', {
      slug: 'people/jane-doe',
      date: '2026-06-10',
      summary: 'Discussed the renewal',
    });

    expect(out.status).toBe(200);
    const result = (out.body as { result: { tool: string; args: Record<string, unknown> } }).result;
    expect(result.tool).toBe('add_timeline_entry');
    expect(result.args).toMatchObject({ slug: 'people/jane-doe', date: '2026-06-10' });
  });

  it('POST /memory/ingest-log defaults the source type', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/ingest-log', {
      source_ref: 'verso://sessions/abc',
      summary: 'Captured one durable decision.',
      pages_updated: ['people/jane-doe', 42],
    });

    expect(out.status).toBe(200);
    const result = (out.body as { result: { tool: string; args: Record<string, unknown> } }).result;
    expect(result.tool).toBe('log_ingest');
    expect(result.args).toMatchObject({
      source_type: 'verso_chat_signal_detector',
      source_ref: 'verso://sessions/abc',
      pages_updated: ['people/jane-doe'],
    });
  });

  it('returns 503 while the runtime is not ready', async () => {
    runtime = new GBrainMemoryRuntime(runtimeConfig({ command: writeFakeGBrainServe() }));
    const routes = buildMemoryRoutes(runtime);
    const out = await callRoute(routes, 'POST', '/memory/search', { query: 'acme' });

    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: 'memory_unavailable' });
  });

  it('maps tool failures to 502', async () => {
    const routes = await readyRoutes();
    const out = await callRoute(routes, 'POST', '/memory/search', { query: 'EXPLODE' });

    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ ok: false, error: 'memory_tool_failed' });
    expect((out.body as { message: string }).message).toContain('search backend exploded');
  });
});

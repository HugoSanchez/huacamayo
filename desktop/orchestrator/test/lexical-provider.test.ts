import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { buildFtsMatchExpression, LexicalMemoryProvider } from '../src/http/lexical-provider.ts';
import { buildMemoryRoutes } from '../src/http/memory-routes.ts';
import type { Route } from '../src/http/router.ts';

let tempRoot = '';
let provider: LexicalMemoryProvider;

beforeEach(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'verso-lexical-test-'));
  provider = new LexicalMemoryProvider({
    enabled: true,
    dbPath: path.join(tempRoot, 'memory', 'verso-memory.db'),
  });
  await provider.start();
});

afterEach(async () => {
  await provider.stop();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('LexicalMemoryProvider pages', () => {
  it('roundtrips put/get and derives the title from the first heading', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nMet at the conference.');

    const page = await provider.getPage('people/jane-doe');
    expect(page).toMatchObject({
      slug: 'people/jane-doe',
      title: 'Jane Doe',
      content: '# Jane Doe\n\nMet at the conference.',
    });
  });

  it('upsert updates content and updated_at but keeps created_at', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nv1');
    const first = await provider.getPage('people/jane-doe');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nv2');
    const second = await provider.getPage('people/jane-doe');

    expect(second!.content).toContain('v2');
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(String(second!.updatedAt) >= String(first!.updatedAt)).toBe(true);
  });

  it('falls back to fuzzy slug lookup', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe');

    expect((await provider.getPage('People/Jane Doe'))?.slug).toBe('people/jane-doe');
    expect((await provider.getPage('jane-doe'))?.slug).toBe('people/jane-doe');
    expect(await provider.getPage('nobody-here')).toBeNull();
  });
});

describe('LexicalMemoryProvider ingestion', () => {
  const segment = {
    sourceRef: 'verso-chat-sess1-42',
    sessionId: 'sess1',
    title: 'Acme kickoff',
    messages: [
      { role: 'user' as const, content: 'I met Sarah Chen from Acme Corp today.', createdAt: '2026-07-01T10:00:00.000Z' },
      { role: 'assistant' as const, content: 'Noted — Acme Corp is evaluating Verso.', createdAt: '2026-07-01T10:00:05.000Z' },
    ],
  };

  it('indexes chat segments and finds them via search', async () => {
    await provider.ingestChatSegment(segment);

    const results = await provider.search('Sarah Chen Acme', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toMatch(/^doc:\d+$/);
    expect(results[0].snippet).toContain('Sarah Chen');
  });

  it('does not duplicate re-ingested chat segments', async () => {
    await provider.ingestChatSegment(segment);
    await provider.ingestChatSegment(segment);

    expect(provider.diagnostics().documents).toBe(1);
  });

  it('dedups source batches on (source, source_ref)', async () => {
    const batch = {
      source: 'gmail',
      stream: '',
      items: [
        { sourceRef: 'm_1', occurredAt: '2026-07-01T09:00:00.000Z', content: 'Subject: Renewal\n\nAcme renewal terms attached.' },
        { sourceRef: 'm_2', occurredAt: '2026-07-02T09:00:00.000Z', content: 'Subject: Lunch\n\nSee you at noon.' },
      ],
    };
    await provider.ingestSourceBatch(batch);
    await provider.ingestSourceBatch(batch);

    expect(provider.diagnostics().documents).toBe(2);
    const results = await provider.search('Acme renewal', 5);
    expect(results).toHaveLength(1);
  });

  it('reads raw documents via doc:<id> slugs', async () => {
    await provider.ingestChatSegment(segment);
    const [hit] = await provider.search('Sarah Chen', 1);

    const page = await provider.getPage(hit.slug!);
    expect(page).toMatchObject({ slug: hit.slug, source: 'chat', stream: 'sess1' });
    expect(page!.content).toContain('Sarah Chen');
  });
});

describe('LexicalMemoryProvider search ranking', () => {
  it('ranks a curated page above a raw document for the same terms', async () => {
    await provider.ingestChatSegment({
      sourceRef: 'seg-1',
      sessionId: 'sess1',
      title: 'chat',
      messages: [{ role: 'user', content: 'Project Atlas deadline is in March.', createdAt: '2026-07-01T10:00:00.000Z' }],
    });
    await provider.putPage('projects/atlas', '# Project Atlas\n\nDeadline: March. Owner: Jane.');

    const results = await provider.search('Project Atlas deadline', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].slug).toBe('projects/atlas');
  });

  it('caps results at the requested limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await provider.putPage(`notes/note-${i}`, `# Note ${i}\n\nkiwi banana ${i}`);
    }
    expect(await provider.search('kiwi banana', 3)).toHaveLength(3);
  });
});

describe('FTS5 query sanitization', () => {
  it.each([
    '"quoted phrase"',
    '-dash -leading',
    "who's asking?",
    'NEAR AND OR NOT',
    'emoji 🚀 query',
    'unbalanced "quote',
    'colon:value AND (parens)',
  ])('never throws for %s', async (query) => {
    await provider.putPage('misc/test', '# Test\n\nquoted phrase who asking near emoji query colon value parens');
    await expect(provider.search(query, 5)).resolves.toBeDefined();
  });

  it('returns no results (not an error) for symbol-only queries', async () => {
    expect(buildFtsMatchExpression('!!! ???')).toBeNull();
    expect(await provider.search('!!! ???', 5)).toEqual([]);
  });
});

describe('lifecycle & diagnostics', () => {
  it('reports disabled when memory is off', async () => {
    const off = new LexicalMemoryProvider({ enabled: false, dbPath: path.join(tempRoot, 'off.db') });
    await off.start();
    expect(off.getState()).toBe('disabled');
    expect(off.isReady()).toBe(false);
    expect(off.diagnostics()).toMatchObject({ enabled: false, backend: 'lexical' });
  });

  it('persists across a stop/start cycle', async () => {
    await provider.putPage('people/jane-doe', '# Jane Doe\n\nDurable.');
    await provider.stop();
    await provider.start();

    expect((await provider.getPage('people/jane-doe'))?.content).toContain('Durable');
  });

  it('counts pages and documents in diagnostics', async () => {
    await provider.putPage('a/b', '# B');
    await provider.ingestSourceBatch({
      source: 'slack',
      stream: 's',
      items: [{ sourceRef: 'r1', content: 'hello' }],
    });

    expect(provider.diagnostics()).toMatchObject({
      enabled: true,
      state: 'ready',
      backend: 'lexical',
      pages: 1,
      documents: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Routes against the real provider
// ---------------------------------------------------------------------------

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

async function callRoute(routes: Route[], method: string, routePath: string, body: unknown): Promise<FakeResponse> {
  const matched = routes.find((r) => r.method === method && r.pattern.test(routePath));
  if (!matched) throw new Error(`No route for ${method} ${routePath}`);
  const { res, out } = fakeRes();
  await matched.handler({} as never, res, {}, body);
  return out;
}

describe('memory routes', () => {
  it('GET /memory/status reports diagnostics and capabilities', async () => {
    const out = await callRoute(buildMemoryRoutes(provider), 'GET', '/memory/status', null);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      state: 'ready',
      enabled: true,
      backend: 'lexical',
      capabilities: { search: true, getPage: true, bridgeWrites: true },
    });
  });

  it('POST /memory/write-page then /memory/search then /memory/page roundtrip', async () => {
    const routes = buildMemoryRoutes(provider);

    const write = await callRoute(routes, 'POST', '/memory/write-page', {
      slug: 'people/jane-doe',
      content: '# Jane Doe\n\nMet at the conference.',
    });
    expect(write.status).toBe(200);

    const search = await callRoute(routes, 'POST', '/memory/search', { query: 'Jane conference' });
    expect(search.status).toBe(200);
    const results = (search.body as { results: Array<{ slug: string }> }).results;
    expect(results[0].slug).toBe('people/jane-doe');

    const page = await callRoute(routes, 'POST', '/memory/page', { slug: 'people/jane-doe' });
    expect(page.status).toBe(200);
    expect((page.body as { page: { content: string } }).page.content).toContain('conference');
  });

  it('validates required fields', async () => {
    const routes = buildMemoryRoutes(provider);
    expect((await callRoute(routes, 'POST', '/memory/search', { limit: 3 })).status).toBe(400);
    expect((await callRoute(routes, 'POST', '/memory/page', {})).status).toBe(400);
    expect((await callRoute(routes, 'POST', '/memory/write-page', { slug: 'x' })).status).toBe(400);
  });

  it('returns 503 while the provider is not ready', async () => {
    const cold = new LexicalMemoryProvider({ enabled: true, dbPath: path.join(tempRoot, 'cold.db') });
    const out = await callRoute(buildMemoryRoutes(cold), 'POST', '/memory/search', { query: 'x' });

    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ ok: false, error: 'memory_unavailable' });
  });

  it('does not register the retired link/timeline/ingest-log routes', () => {
    const routes = buildMemoryRoutes(provider);
    for (const retired of ['/memory/link', '/memory/timeline', '/memory/ingest-log']) {
      expect(routes.find((r) => r.pattern.test(retired))).toBeUndefined();
    }
  });
});

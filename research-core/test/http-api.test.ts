import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { route, dispatch, json, type Route } from '../src/http/router.ts';
import { hybridSearch } from '../src/engine/search/hybrid.ts';
import { importFromContent } from '../src/engine/import-file.ts';

// Inline route builder (mirrors server.ts but with injected engine)
function buildRoutes(engine: BrainEngine): Route[] {
  return [
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok' });
    }),
    route('GET', '/pages', async (_req, res, params) => {
      const filters: Record<string, unknown> = {};
      if (params.type) filters.type = params.type;
      if (params.limit) filters.limit = parseInt(params.limit, 10);
      json(res, 200, await engine.listPages(filters));
    }),
    route('GET', '/tags', async (_req, res) => {
      json(res, 200, await engine.listAllTags());
    }),
    route('GET', '/pages/:slug/tags', async (_req, res, params) => {
      json(res, 200, await engine.getTags(params.slug));
    }),
    route('POST', '/pages/:slug/tags', async (_req, res, params, body) => {
      const { tag } = body as { tag: string };
      await engine.addTag(params.slug, tag);
      json(res, 201, { status: 'added' });
    }),
    route('GET', '/pages/:slug', async (_req, res, params) => {
      const page = await engine.getPage(params.slug);
      if (!page) return json(res, 404, { error: 'not_found' });
      json(res, 200, page);
    }),
    route('PUT', '/pages/:slug', async (_req, res, params, body) => {
      const page = await engine.putPage(params.slug, body as any);
      json(res, 200, page);
    }),
    route('DELETE', '/pages/:slug', async (_req, res, params) => {
      await engine.deletePage(params.slug);
      json(res, 200, { status: 'deleted' });
    }),
    route('GET', '/sources', async (_req, res) => {
      json(res, 200, await engine.listSources());
    }),
    route('POST', '/sources', async (_req, res, _p, body) => {
      json(res, 201, await engine.createSource(body as any));
    }),
    route('GET', '/sources/:id', async (_req, res, params) => {
      const s = await engine.getSource(params.id);
      if (!s) return json(res, 404, { error: 'not_found' });
      json(res, 200, s);
    }),
    route('DELETE', '/sources/:id', async (_req, res, params) => {
      await engine.deleteSource(params.id);
      json(res, 200, { status: 'deleted' });
    }),
    route('GET', '/contexts', async (_req, res) => {
      json(res, 200, await engine.listContexts());
    }),
    route('POST', '/contexts', async (_req, res, _p, body) => {
      json(res, 201, await engine.createContext(body as any));
    }),
    route('GET', '/contexts/:id', async (_req, res, params) => {
      const c = await engine.getContext(params.id);
      if (!c) return json(res, 404, { error: 'not_found' });
      json(res, 200, c);
    }),
    route('DELETE', '/contexts/:id', async (_req, res, params) => {
      await engine.deleteContext(params.id);
      json(res, 200, { status: 'deleted' });
    }),
    route('POST', '/search', async (_req, res, _p, body) => {
      const { query, limit, contextId } = body as any;
      const results = await hybridSearch(engine, query, { limit, contextId });
      json(res, 200, results);
    }),
    route('POST', '/import', async (_req, res, _p, body) => {
      const { slug, content, sourceId } = body as any;
      const result = await importFromContent(engine, slug, content, { noEmbed: true, sourceId });
      json(res, 200, result);
    }),
    route('GET', '/stats', async (_req, res) => {
      json(res, 200, await engine.getStats());
    }),
  ];
}

// Helper to make HTTP requests
function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode!, data: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('HTTP API', () => {
  let engine: BrainEngine;
  let server: http.Server;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    const routes = buildRoutes(engine);
    server = http.createServer((req, res) => {
      dispatch(routes, req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    server.close();
    await engine.disconnect();
  });

  it('GET /health returns ok', async () => {
    const { status, data } = await request(server, 'GET', '/health');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await request(server, 'GET', '/nonexistent');
    expect(status).toBe(404);
  });

  it('full page lifecycle: create, read, delete', async () => {
    // Create
    const { status: putStatus, data: page } = await request(server, 'PUT', '/pages/test/hello', {
      type: 'concept',
      title: 'Hello',
      compiled_truth: 'Hello world.',
    });
    expect(putStatus).toBe(200);
    expect(page.slug).toBe('test/hello');

    // Read
    const { status: getStatus, data: fetched } = await request(server, 'GET', '/pages/test/hello');
    expect(getStatus).toBe(200);
    expect(fetched.title).toBe('Hello');

    // Delete
    const { status: delStatus } = await request(server, 'DELETE', '/pages/test/hello');
    expect(delStatus).toBe(200);

    // Verify deleted
    const { status: gone } = await request(server, 'GET', '/pages/test/hello');
    expect(gone).toBe(404);
  });

  it('source CRUD via HTTP', async () => {
    const { status: createStatus, data: src } = await request(server, 'POST', '/sources', {
      id: 'http-src', location: '/tmp/http-test',
    });
    expect(createStatus).toBe(201);
    expect(src.id).toBe('http-src');

    const { data: fetched } = await request(server, 'GET', '/sources/http-src');
    expect(fetched.id).toBe('http-src');

    const { data: list } = await request(server, 'GET', '/sources');
    expect(list.length).toBeGreaterThan(0);

    await request(server, 'DELETE', '/sources/http-src');
    const { status: gone } = await request(server, 'GET', '/sources/http-src');
    expect(gone).toBe(404);
  });

  it('context CRUD via HTTP', async () => {
    const { data: ctx } = await request(server, 'POST', '/contexts', {
      id: 'http-ctx', name: 'Test Context',
    });
    expect(ctx.id).toBe('http-ctx');

    const { data: fetched } = await request(server, 'GET', '/contexts/http-ctx');
    expect(fetched.name).toBe('Test Context');

    await request(server, 'DELETE', '/contexts/http-ctx');
    const { status: gone } = await request(server, 'GET', '/contexts/http-ctx');
    expect(gone).toBe(404);
  });

  it('import and search', async () => {
    // Import a page
    const { data: imported } = await request(server, 'POST', '/import', {
      slug: 'test/search-me',
      content: '---\ntitle: Searchable\ntype: concept\n---\nNeural networks are powerful.',
    });
    expect(imported.status).toBe('imported');

    // Keyword search should find it
    const { data: results } = await request(server, 'POST', '/search', {
      query: 'neural networks',
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].slug).toBe('test/search-me');
  });

  it('tags CRUD via HTTP', async () => {
    // Create a page first
    await request(server, 'PUT', '/pages/test/tagged', {
      type: 'concept', title: 'Tagged', compiled_truth: 'Content.',
    });

    // Add tag
    const { status: tagStatus } = await request(server, 'POST', '/pages/test/tagged/tags', { tag: 'ml' });
    expect(tagStatus).toBe(201);

    // List page tags
    const { data: tags } = await request(server, 'GET', '/pages/test/tagged/tags');
    expect(tags).toContain('ml');

    // List all tags
    const { data: allTags } = await request(server, 'GET', '/tags');
    expect(allTags).toContain('ml');
  });

  it('GET /stats returns stats', async () => {
    const { status, data } = await request(server, 'GET', '/stats');
    expect(status).toBe(200);
    expect(data).toHaveProperty('page_count');
  });
});

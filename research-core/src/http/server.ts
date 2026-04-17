import http from 'node:http';
import type { BrainEngine } from '../engine/engine.ts';
import { loadConfig, toEngineConfig } from '../engine/config.ts';
import { createEngine } from '../engine/engine-factory.ts';
import { hybridSearch } from '../engine/search/hybrid.ts';
import { importFromContent } from '../engine/import-file.ts';
import {
  isAvailable as embeddingAvailable,
  isLoaded as embeddingLoaded,
  dispose as disposeEmbedding,
  EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
} from '../engine/embedding.ts';
import {
  isRerankerAvailable, isRerankerLoaded,
  disposeReranker, RERANKER_MODEL,
} from '../engine/search/rerank.ts';
import { route, dispatch, json, type Route } from './router.ts';

function buildRoutes(engine: BrainEngine): Route[] {
  return [
    // Health
    route('GET', '/health', async (_req, res) => {
      json(res, 200, { status: 'ok', timestamp: Date.now() });
    }),

    // --- Pages ---
    route('GET', '/pages', async (_req, res, params) => {
      const filters: Record<string, unknown> = {};
      if (params.type) filters.type = params.type;
      if (params.tag) filters.tag = params.tag;
      if (params.limit) filters.limit = parseInt(params.limit, 10);
      if (params.offset) filters.offset = parseInt(params.offset, 10);
      const pages = await engine.listPages(filters);
      json(res, 200, pages);
    }),

    // Tags routes must come before /pages/:slug to avoid slug capturing "tags"
    route('GET', '/tags', async (_req, res) => {
      const tags = await engine.listAllTags();
      json(res, 200, tags);
    }),

    route('GET', '/pages/:slug/tags', async (_req, res, params) => {
      const tags = await engine.getTags(params.slug);
      json(res, 200, tags);
    }),

    route('POST', '/pages/:slug/tags', async (_req, res, params, body) => {
      const { tag } = body as { tag: string };
      if (!tag) return json(res, 400, { error: 'bad_request', message: 'Missing "tag" field' });
      await engine.addTag(params.slug, tag);
      json(res, 201, { status: 'added', slug: params.slug, tag });
    }),

    route('DELETE', '/pages/:slug/tags/:tag', async (_req, res, params) => {
      await engine.removeTag(params.slug, params.tag);
      json(res, 200, { status: 'removed' });
    }),

    route('GET', '/pages/:slug', async (_req, res, params) => {
      const page = await engine.getPage(params.slug);
      if (!page) return json(res, 404, { error: 'not_found', message: `Page not found: ${params.slug}` });
      const tags = await engine.getTags(params.slug);
      json(res, 200, { ...page, tags });
    }),

    route('PUT', '/pages/:slug', async (_req, res, params, body) => {
      const page = await engine.putPage(params.slug, body as Parameters<BrainEngine['putPage']>[1]);
      json(res, 200, page);
    }),

    route('DELETE', '/pages/:slug', async (_req, res, params) => {
      await engine.deletePage(params.slug);
      json(res, 200, { status: 'deleted' });
    }),

    // --- Sources ---
    route('GET', '/sources', async (_req, res) => {
      json(res, 200, await engine.listSources());
    }),

    route('POST', '/sources', async (_req, res, _params, body) => {
      const source = await engine.createSource(body as Parameters<BrainEngine['createSource']>[0]);
      json(res, 201, source);
    }),

    route('GET', '/sources/:id', async (_req, res, params) => {
      const source = await engine.getSource(params.id);
      if (!source) return json(res, 404, { error: 'not_found', message: `Source not found: ${params.id}` });
      json(res, 200, source);
    }),

    route('PATCH', '/sources/:id/status', async (_req, res, params, body) => {
      const { status } = body as { status: string };
      if (!status) return json(res, 400, { error: 'bad_request', message: 'Missing "status" field' });
      await engine.updateSourceStatus(params.id, status);
      json(res, 200, { status: 'updated' });
    }),

    route('DELETE', '/sources/:id', async (_req, res, params) => {
      await engine.deleteSource(params.id);
      json(res, 200, { status: 'deleted' });
    }),

    // --- Contexts ---
    route('GET', '/contexts', async (_req, res) => {
      json(res, 200, await engine.listContexts());
    }),

    route('POST', '/contexts', async (_req, res, _params, body) => {
      const ctx = await engine.createContext(body as Parameters<BrainEngine['createContext']>[0]);
      json(res, 201, ctx);
    }),

    route('GET', '/contexts/:id/sources', async (_req, res, params) => {
      const sourceIds = await engine.getContextSourceIds(params.id);
      json(res, 200, sourceIds);
    }),

    route('POST', '/contexts/:id/sources', async (_req, res, params, body) => {
      const { sourceId } = body as { sourceId: string };
      if (!sourceId) return json(res, 400, { error: 'bad_request', message: 'Missing "sourceId" field' });
      await engine.addSourceToContext(params.id, sourceId);
      json(res, 201, { status: 'added' });
    }),

    route('DELETE', '/contexts/:id/sources/:sourceId', async (_req, res, params) => {
      await engine.removeSourceFromContext(params.id, params.sourceId);
      json(res, 200, { status: 'removed' });
    }),

    route('GET', '/contexts/:id', async (_req, res, params) => {
      const ctx = await engine.getContext(params.id);
      if (!ctx) return json(res, 404, { error: 'not_found', message: `Context not found: ${params.id}` });
      json(res, 200, ctx);
    }),

    route('DELETE', '/contexts/:id', async (_req, res, params) => {
      await engine.deleteContext(params.id);
      json(res, 200, { status: 'deleted' });
    }),

    // --- Search ---
    route('POST', '/search', async (_req, res, _params, body) => {
      const { query, limit, contextId, rerank } = body as {
        query: string; limit?: number; contextId?: string; rerank?: boolean;
      };
      if (!query) return json(res, 400, { error: 'bad_request', message: 'Missing "query" field' });
      const results = await hybridSearch(engine, query, { limit, contextId, rerank });
      json(res, 200, results);
    }),

    // --- Import ---
    route('POST', '/import', async (_req, res, _params, body) => {
      const { slug, content, sourceId } = body as { slug: string; content: string; sourceId?: string };
      if (!slug || !content) return json(res, 400, { error: 'bad_request', message: 'Missing "slug" or "content"' });
      const result = await importFromContent(engine, slug, content, { sourceId });
      json(res, 200, result);
    }),

    // --- Graph ---
    route('GET', '/graph/:slug', async (_req, res, params) => {
      const depth = params.depth ? parseInt(params.depth, 10) : 5;
      const [graph, links, backlinks] = await Promise.all([
        engine.traverseGraph(params.slug, depth),
        engine.getLinks(params.slug),
        engine.getBacklinks(params.slug),
      ]);
      json(res, 200, { graph, links, backlinks });
    }),

    // --- Stats ---
    route('GET', '/stats', async (_req, res) => {
      json(res, 200, await engine.getStats());
    }),

    route('GET', '/stats/health', async (_req, res) => {
      json(res, 200, await engine.getHealth());
    }),

    // --- Embedding / Reranker status ---
    route('GET', '/embedding/status', async (_req, res) => {
      json(res, 200, {
        embedding: {
          available: embeddingAvailable(),
          loaded: embeddingLoaded(),
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
        },
        reranker: {
          available: isRerankerAvailable(),
          loaded: isRerankerLoaded(),
          model: RERANKER_MODEL,
        },
      });
    }),
  ];
}

export async function startServer(opts: { port?: number } = {}): Promise<{
  server: http.Server;
  engine: BrainEngine;
  port: number;
}> {
  const config = loadConfig() || { engine: 'pglite' as const };
  const engineConfig = toEngineConfig(config);

  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  await engine.initSchema();

  const routes = buildRoutes(engine);
  const server = http.createServer((req, res) => {
    dispatch(routes, req, res);
  });

  const port = opts.port ?? parseInt(process.env.PORT || '0', 10);

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, engine, port: addr.port });
    });
  });
}

// CLI entry point
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/server.ts') ||
  process.argv[1].endsWith('/server.js')
);

if (isMain) {
  startServer().then(({ server, engine, port }) => {
    // Structured JSON line for the Swift app to parse
    console.log(JSON.stringify({ port, status: 'ready' }));

    const shutdown = async () => {
      server.close();
      await disposeEmbedding();
      await disposeReranker();
      await engine.disconnect();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }).catch((err) => {
    console.error(JSON.stringify({ status: 'error', message: err.message }));
    process.exit(1);
  });
}

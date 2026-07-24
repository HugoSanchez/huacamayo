import http from 'node:http';
import type { LocalEmbedder } from '../http/embedder.ts';
import type { SourceIngestionScheduler } from '../http/source-ingestion.ts';
import type { PgMemoryProvider } from './pg-memory-provider.ts';

/**
 * memoryd's HTTP surface:
 *  - POST /embed  — TEI-compatible: {"inputs": ["text", …]} → [[float…], …].
 *    Raw embeddings, NO e5 prefixes (callers add query:/passage: themselves —
 *    this is the contract the sandbox memory CLI already speaks for
 *    MEMORY_EMBEDDER_URL).
 *  - GET /healthz — liveness (200 as long as the process serves).
 *  - GET /status  — memory counts, embedder state, per-source ingestion views.
 */

const MAX_INPUTS = 64;
const MAX_INPUT_CHARS = 16_000;

export function createMemorydServer(deps: {
  embedder: LocalEmbedder;
  provider: PgMemoryProvider;
  scheduler: SourceIngestionScheduler;
}): http.Server {
  return http.createServer((req, res) => {
    void route(deps, req, res).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function route(
  deps: { embedder: LocalEmbedder; provider: PgMemoryProvider; scheduler: SourceIngestionScheduler },
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    sendJson(res, 200, {
      memory: { ...deps.provider.diagnostics(), ...(await deps.provider.counts()) },
      ingestion: deps.scheduler.listSources(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/embed') {
    const body = await readBody(req);
    let inputs: unknown;
    try {
      inputs = (JSON.parse(body) as { inputs?: unknown }).inputs;
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((x) => typeof x === 'string')) {
      sendJson(res, 400, { error: 'body must be {"inputs": [string, …]}' });
      return;
    }
    if (inputs.length > MAX_INPUTS) {
      sendJson(res, 413, { error: `too many inputs (max ${MAX_INPUTS})` });
      return;
    }
    if (!deps.embedder.isReady()) {
      sendJson(res, 503, { error: `embedder not ready (state: ${deps.embedder.getState()})` });
      return;
    }
    const vectors = await deps.embedder.embedRaw(
      (inputs as string[]).map((text) => text.slice(0, MAX_INPUT_CHARS)),
    );
    sendJson(res, 200, vectors.map((vector) => Array.from(vector)));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

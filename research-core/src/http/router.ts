import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  body: unknown,
) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

const MAX_BODY = 10 * 1024 * 1024; // 10MB

/** Read request body as parsed JSON (or null for empty bodies). */
export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Send a JSON response. */
export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Register a route with :param syntax. */
export function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  // Convert :param to named capture groups. Use .+ for :slug (greedy) and [^/]+ for others.
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, key) => {
    keys.push(key);
    return key === 'slug' ? '(.+)' : '([^/]+)';
  });
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${pattern}$`),
    keys,
    handler,
  };
}

/** Dispatch a request to the matching route. */
export async function dispatch(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || 'GET';

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = pathname.match(r.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let i = 0; i < r.keys.length; i++) {
      params[r.keys[i]] = decodeURIComponent(match[i + 1]);
    }

    // Also expose query params
    for (const [k, v] of url.searchParams) {
      if (!(k in params)) params[k] = v;
    }

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : null;
      await r.handler(req, res, params, body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Invalid JSON') {
        json(res, 400, { error: 'bad_request', message: 'Invalid JSON body' });
      } else if (message === 'Request body too large') {
        json(res, 413, { error: 'payload_too_large', message });
      } else {
        console.error(`[http] ${method} ${pathname} error:`, err);
        json(res, 500, { error: 'internal_error', message });
      }
    }
    return;
  }

  json(res, 404, { error: 'not_found', message: `No route for ${method} ${pathname}` });
}

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

const MAX_BODY = 10 * 1024 * 1024;

export function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });

  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${pattern}$`),
    keys,
    handler,
  };
}

export async function dispatch(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Vervo-Bridge-Token');

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = pathname.match(candidate.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    for (let index = 0; index < candidate.keys.length; index += 1) {
      params[candidate.keys[index]] = decodeURIComponent(match[index + 1]);
    }
    for (const [key, value] of url.searchParams) {
      if (!(key in params)) params[key] = value;
    }

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : null;
      await candidate.handler(req, res, params, body);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'Invalid JSON') {
        json(res, 400, { error: 'bad_request', message: 'Invalid JSON body' });
      } else if (message === 'Request body too large') {
        json(res, 413, { error: 'payload_too_large', message });
      } else {
        console.error(`[bridge] ${method} ${pathname} error:`, error);
        json(res, 500, { error: 'internal_error', message });
      }
    }

    return;
  }

  json(res, 404, { error: 'not_found', message: `No route for ${method} ${pathname}` });
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (size === 0) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

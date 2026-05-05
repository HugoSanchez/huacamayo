import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import { ConnectionsService, HttpError } from '../integrations/composio.ts';

export function buildConnectionsRoutes(connections: ConnectionsService): Route[] {
  return [
    route('GET', '/connections', async (_req, res) => {
      const items = await connections.listConnections();
      json(res, 200, {
        available: connections.configured,
        configured: connections.configured,
        connections: items,
      });
    }),

    route('GET', '/connections/toolkits', async (_req, res, params) => {
      try {
        const query = typeof params.query === 'string' ? params.query : undefined;
        const cursor = typeof params.cursor === 'string' && params.cursor.length > 0
          ? params.cursor
          : undefined;
        const rawLimit = typeof params.limit === 'string' ? Number.parseInt(params.limit, 10) : Number.NaN;
        const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
        const result = await connections.listToolkits({ query, cursor, limit });
        json(res, 200, {
          available: connections.configured,
          configured: connections.configured,
          toolkits: result.toolkits,
          nextCursor: result.nextCursor,
        });
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
    }),

    route('POST', '/connections/request', async (req, res, _params, body) => {
      try {
        const toolkit = typeof (body as { toolkit?: unknown } | null)?.toolkit === 'string'
          ? ((body as { toolkit?: string }).toolkit ?? '').trim()
          : '';
        if (!toolkit) {
          return json(res, 400, { error: 'bad_request', message: 'Missing "toolkit"' });
        }

        const request = await connections.requestConnection(toolkit, requestBaseUrl(req));
        json(res, 201, { request });
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
    }),

    route('GET', '/connections/requests/:id', async (_req, res, params) => {
      const request = await connections.getRequest(params.id);
      if (!request) {
        return json(res, 404, { error: 'not_found', message: `Unknown request: ${params.id}` });
      }

      json(res, 200, {
        available: connections.configured,
        configured: connections.configured,
        request,
      });
    }),

    route('GET', '/connections/requests/:id/open', async (_req, res, params) => {
      const redirectUrl = connections.getRequestRedirectUrl(params.id);
      if (!redirectUrl) {
        return sendHtml(
          res,
          404,
          renderCallbackPage('Connection unavailable', 'This connection link is no longer available. Return to Vervo and try again.'),
        );
      }

      res.writeHead(302, { Location: redirectUrl });
      res.end();
    }),

    route('GET', '/connections/callback', async (_req, res, params) => {
      const status = typeof params.status === 'string' ? params.status.toLowerCase() : '';
      const isFailed = status === 'failed';
      const title = isFailed ? 'Connection failed' : 'Connection complete';
      const message = isFailed
        ? 'The connection did not complete. You can return to Vervo and try again.'
        : 'You can return to Vervo now. The app will update automatically.';
      sendHtml(res, 200, renderCallbackPage(title, message));
    }),
  ];
}

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || '127.0.0.1';
  return `http://${host}`;
}

function renderCallbackPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
        background: #141618;
        color: rgba(255, 255, 255, 0.88);
        display: grid;
        min-height: 100vh;
        place-items: center;
      }
      main {
        width: min(460px, calc(100vw - 32px));
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 18px;
        padding: 28px;
        background: rgba(255, 255, 255, 0.04);
      }
      h1 { margin: 0 0 12px; font-size: 20px; }
      p { margin: 0; line-height: 1.5; color: rgba(255, 255, 255, 0.68); }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function handleHttpError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

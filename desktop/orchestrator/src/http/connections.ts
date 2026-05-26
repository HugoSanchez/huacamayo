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

    route('DELETE', '/connections/:id', async (_req, res, params) => {
      try {
        await connections.deleteConnection(params.id);
        res.writeHead(204);
        res.end();
      } catch (error: unknown) {
        handleHttpError(res, error);
      }
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
          renderCallbackPage('Connection unavailable', 'This connection link is no longer available. Return to verso and try again.'),
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
        ? 'The connection did not complete. You can return to verso and try again.'
        : 'You can return to verso now. The app will update automatically.';
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
      :root { color-scheme: light; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        background: #F3F5F7;
        color: rgba(0, 0, 0, 0.85);
        display: flex;
        flex-direction: column;
        min-height: 100vh;
      }
      header {
        height: 38px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 600;
        color: rgba(0, 0, 0, 0.85);
      }
      main {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 35px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: rgba(0, 0, 0, 0.85);
      }
      p {
        margin: 0;
        max-width: 300px;
        text-align: center;
        font-size: 13px;
        line-height: 1.55;
        color: rgba(0, 0, 0, 0.55);
      }
    </style>
  </head>
  <body>
    <header>verso.</header>
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

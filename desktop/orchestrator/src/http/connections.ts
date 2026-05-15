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
          renderCallbackPage('Connection unavailable', 'This connection link is no longer available. Return to verso and try again.', 'error'),
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
      sendHtml(res, 200, renderCallbackPage(title, message, isFailed ? 'error' : 'success'));
    }),
  ];
}

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host || '127.0.0.1';
  return `http://${host}`;
}

function renderCallbackPage(title: string, message: string, kind: 'success' | 'error' = 'error'): string {
  const icon = kind === 'success' ? renderSuccessIcon() : renderErrorIcon();
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
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
        background: #F3F5F7;
        color: rgba(0, 0, 0, 0.85);
        display: grid;
        min-height: 100vh;
        place-items: center;
      }
      main {
        text-align: center;
        padding: 24px;
        max-width: 420px;
      }
      .icon {
        display: inline-flex;
        margin-bottom: 20px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: rgba(0, 0, 0, 0.55);
      }
      @media (prefers-color-scheme: dark) {
        body { background: #141618; color: rgba(255, 255, 255, 0.88); }
        p { color: rgba(255, 255, 255, 0.55); }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="icon">${icon}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function renderSuccessIcon(): string {
  return `<svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#2e7d32" />
    <polyline points="7 12.5 10.5 16 17 9" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

function renderErrorIcon(): string {
  return `<svg width="56" height="56" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#c0392b" />
    <line x1="8" y1="8" x2="16" y2="16" stroke="white" stroke-width="2.4" stroke-linecap="round" />
    <line x1="16" y1="8" x2="8" y2="16" stroke="white" stroke-width="2.4" stroke-linecap="round" />
  </svg>`;
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

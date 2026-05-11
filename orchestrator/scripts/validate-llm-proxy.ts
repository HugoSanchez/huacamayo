/**
 * Spins up a minimal HTTP server that mounts ONLY the LLM proxy + session
 * push routes against a real ManagedBackendClient. This isolates the proxy's
 * architectural validation from the rest of the orchestrator (no Hermes, no
 * chat store, no skills supervisor) so we can prove the seam:
 *
 *   curl/Python → /llm/v1/chat/completions
 *     → ManagedBackendClient → backend /v1/chat/completions → OpenRouter
 *
 * Usage: VERVO_BACKEND_URL=http://127.0.0.1:8788 PORT=0 npx tsx scripts/validate-llm-proxy.ts
 *
 * Prints `{"port":N,"status":"ready"}` on stdout when ready.
 */

import http from 'node:http';
import { dispatch, json, route, type Route } from '../src/http/router.ts';
import { ManagedBackendClient, type ManagedSessionRecord } from '../src/integrations/managed-backend-client.ts';
import { buildLlmProxyRoutes } from '../src/http/llm-proxy.ts';

const managedBackend = new ManagedBackendClient();
const routes: Route[] = [
  route('GET', '/health', async (_req, res) => {
    json(res, 200, { status: 'ok' });
  }),
  route('POST', '/managed/session', async (_req, res, _params, body) => {
    const parsed = parseSessionBody(body);
    if (parsed === 'invalid') {
      json(res, 400, { error: 'bad_request', message: 'Invalid managed session payload.' });
      return;
    }
    managedBackend.setSession(parsed);
    json(res, 200, { ok: true });
  }),
  ...buildLlmProxyRoutes(managedBackend),
];

const server = http.createServer((req, res) => {
  dispatch(routes, req, res);
});

const port = parseInt(process.env.PORT || '0', 10);
server.listen(port, '127.0.0.1', () => {
  const addr = server.address() as { port: number };
  console.log(JSON.stringify({ port: addr.port, status: 'ready', pid: process.pid }));
});

function parseSessionBody(body: unknown): ManagedSessionRecord | null | 'invalid' {
  if (body === null || body === undefined) return null;
  if (typeof body !== 'object') return 'invalid';
  const source = body as Record<string, unknown>;
  const token = typeof source.token === 'string' ? source.token.trim() : '';
  const expiresAt = typeof source.expiresAt === 'string' ? source.expiresAt.trim() : '';
  const userId = typeof source.userId === 'string' ? source.userId.trim() : '';
  if (!token || !expiresAt || !userId) return 'invalid';
  return {
    token,
    expiresAt,
    userId,
    email: typeof source.email === 'string' ? source.email : null,
    displayName: typeof source.displayName === 'string' ? source.displayName : null,
    receivedAt: typeof source.receivedAt === 'string' ? source.receivedAt : new Date().toISOString(),
  };
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

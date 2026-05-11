import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route, type Route } from './router.ts';
import { ManagedBackendClient } from '../integrations/managed-backend-client.ts';

/**
 * Local OpenAI-compatible proxy that lets a local agent (Hermes) speak
 * `/v1/chat/completions` against the orchestrator without ever seeing the
 * managed backend session token. The orchestrator strips whatever
 * Authorization header arrives, attaches the in-memory bearer token, and pipes
 * the upstream SSE bytes back unchanged.
 *
 * Mounted at POST /llm/v1/chat/completions so an OpenAI client configured with
 * base_url=http://127.0.0.1:<port>/llm/v1 lands on it directly.
 */
export function buildLlmProxyRoutes(managedBackend: ManagedBackendClient): Route[] {
  return [
    route('POST', '/llm/v1/chat/completions', async (req, res, _params, body) => {
      await proxyChatCompletion(managedBackend, req, res, body);
    }),
  ];
}

async function proxyChatCompletion(
  managedBackend: ManagedBackendClient,
  _req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const session = managedBackend.getStoredSession();
  if (!session) {
    json(res, 401, {
      error: { code: 'missing_session', message: 'No managed session loaded in the orchestrator.' },
    });
    return;
  }

  if (isExpired(session.expiresAt)) {
    json(res, 401, {
      error: { code: 'expired_session', message: 'Managed session has expired locally.' },
    });
    return;
  }

  if (!body || typeof body !== 'object') {
    json(res, 400, {
      error: { code: 'bad_request', message: 'Body must be a JSON object.' },
    });
    return;
  }

  let upstream: Response;
  try {
    upstream = await managedBackend.forwardChatCompletion(body as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(res, 502, {
      error: { code: 'backend_unreachable', message },
    });
    return;
  }

  // Mirror the upstream status + content-type, then pipe bytes verbatim.
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  res.writeHead(upstream.status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Surface the inference id so the orchestrator (or a debug client) can
    // correlate this call with the row written in `inference_requests`.
    ...(upstream.headers.get('x-inference-request-id')
      ? { 'X-Inference-Request-Id': upstream.headers.get('x-inference-request-id')! }
      : {}),
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_interrupted', message })}\n\n`);
    } catch { /* socket may already be closed */ }
  } finally {
    res.end();
  }
}

function isExpired(value: string): boolean {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now();
}

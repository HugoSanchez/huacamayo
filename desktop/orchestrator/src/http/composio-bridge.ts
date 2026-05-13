import { json, route, type Route } from './router.ts';
import { ComposioBridgeHttpError, ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { RemoteBridgeHttpError } from '../integrations/composio-bridge-client.ts';

// Tool discovery and execution have moved to Composio's hosted MCP server,
// which Hermes connects to directly (see HermesSupervisor.refreshComposioMcpSession).
// This module now only exposes the session-fetch hop, kept so existing
// debugging / admin paths can still surface the current MCP URL on demand.
export function buildComposioBridgeRoutes(bridge: ComposioBridgeService): Route[] {
  return [
    route('GET', '/composio/session', async (_req, res) => {
      try {
        const session = await bridge.getDefaultSession();
        json(res, 200, {
          available: bridge.configured,
          configured: bridge.configured,
          session,
        });
      } catch (error: unknown) {
        handleBridgeError(res, error);
      }
    }),

    route('POST', '/composio/session/reset', async (_req, res) => {
      bridge.reset();
      json(res, 200, { ok: true });
    }),
  ];
}

function handleBridgeError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof ComposioBridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  if (error instanceof RemoteBridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

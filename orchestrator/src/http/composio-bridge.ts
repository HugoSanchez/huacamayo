import { json, route, type Route } from './router.ts';
import { ComposioBridgeHttpError, ComposioBridgeService } from '../integrations/composio-bridge.ts';
import { RemoteBridgeHttpError } from '../integrations/composio-bridge-client.ts';

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

    route('POST', '/composio/tools/search', async (_req, res, _params, body) => {
      try {
        const query = getRequiredString(body, 'query');
        const toolkits = getOptionalStringArray(body, 'toolkits');
        const results = await bridge.searchTools(query, toolkits);
        json(res, 200, { results });
      } catch (error: unknown) {
        handleBridgeError(res, error);
      }
    }),

    route('POST', '/composio/tools/schemas', async (_req, res, _params, body) => {
      try {
        const toolSlugs = getRequiredStringArray(body, 'toolSlugs');
        const tools = await bridge.getToolSchemas(toolSlugs);
        json(res, 200, { tools });
      } catch (error: unknown) {
        handleBridgeError(res, error);
      }
    }),

    route('POST', '/composio/tools/execute', async (_req, res, _params, body) => {
      try {
        const toolSlug = getRequiredString(body, 'toolSlug');
        const arguments_ = getOptionalRecord(body, 'arguments');
        const result = await bridge.executeTool(toolSlug, arguments_ ?? undefined);
        json(res, 200, { result });
      } catch (error: unknown) {
        handleBridgeError(res, error);
      }
    }),
  ];
}

function handleBridgeError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof ComposioBridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  if (error instanceof RemoteBridgeHttpError) {
    // Bubble up the upstream status from the backend (401 missing_session,
    // 503 backend down, etc.) so callers can react appropriately rather
    // than seeing every Composio failure as 500.
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function getRequiredString(body: unknown, key: string): string {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ComposioBridgeHttpError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function getRequiredStringArray(body: unknown, key: string): string[] {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new ComposioBridgeHttpError(400, `Missing "${key}"`);
  }
  return value.map((item) => (item as string).trim());
}

function getOptionalStringArray(body: unknown, key: string): string[] | undefined {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ComposioBridgeHttpError(400, `Invalid "${key}"`);
  }
  return value.map((item) => (item as string).trim()).filter(Boolean);
}

function getOptionalRecord(body: unknown, key: string): Record<string, unknown> | null {
  const value = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposioBridgeHttpError(400, `Invalid "${key}"`);
  }
  return value as Record<string, unknown>;
}

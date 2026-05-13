import { json, route, type Route } from './router.ts';
import { ToolGatewayHttpError, ToolGatewayService } from '../integrations/tool-gateway.ts';
import { ComposioBridgeHttpError } from '../integrations/composio-bridge.ts';
import { RemoteBridgeHttpError } from '../integrations/composio-bridge-client.ts';

export function buildToolGatewayRoutes(gateway: ToolGatewayService): Route[] {
  return [
    route('POST', '/apps/actions/find', async (_req, res, _params, body) => {
      try {
        const input = bodyRecord(body);
        const actions = await gateway.findActions({
          app: optionalString(input.app),
          intent: requiredString(input.intent, 'intent'),
          limit: optionalNumber(input.limit),
        });
        json(res, 200, {
          available: gateway.configured,
          configured: gateway.configured,
          actions,
        });
      } catch (error: unknown) {
        handleGatewayError(res, error);
      }
    }),

    route('POST', '/apps/actions/schema', async (_req, res, _params, body) => {
      try {
        const input = bodyRecord(body);
        const action = await gateway.getActionSchema(requiredString(input.actionId ?? input.action_id, 'action_id'));
        json(res, 200, { action });
      } catch (error: unknown) {
        handleGatewayError(res, error);
      }
    }),

    route('POST', '/apps/actions/execute', async (_req, res, _params, body) => {
      try {
        const input = bodyRecord(body);
        const result = await gateway.executeAction(
          requiredString(input.actionId ?? input.action_id, 'action_id'),
          optionalRecord(input.arguments) ?? {},
        );
        json(res, 200, result);
      } catch (error: unknown) {
        handleGatewayError(res, error);
      }
    }),
  ];
}

function handleGatewayError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof ToolGatewayHttpError || error instanceof ComposioBridgeHttpError || error instanceof RemoteBridgeHttpError) {
    json(res, error.status, { error: 'request_failed', message: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { error: 'internal_error', message });
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolGatewayHttpError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolGatewayHttpError(400, 'Invalid "arguments"');
  }
  return value as Record<string, unknown>;
}

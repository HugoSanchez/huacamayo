import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import { ComposioService, ComposioServiceError } from '../composio/service.ts';

export interface ComposioRouteDeps {
  authService: AuthService;
  composioService: ComposioService;
}

/**
 * Auth'd Composio surface. The backend now only mints the per-user session
 * URL and brokers OAuth connection flows — tool discovery and execution have
 * moved to Composio's hosted MCP server (Hermes connects to it directly).
 *
 * Every route authenticates the bearer and uses `auth.user.id` as the Composio
 * user id, so a client can never act as someone else.
 */
export async function registerComposioRoutes(app: FastifyInstance, deps: ComposioRouteDeps): Promise<void> {
  app.post('/v1/composio/session', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const session = await deps.composioService.getSession(auth.user.id);
      return reply.code(200).send({ session });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/session/reset', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      deps.composioService.resetSession(auth.user.id);
      return reply.code(200).send({ ok: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/v1/composio/connections', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const connections = await deps.composioService.listConnections(auth.user.id);
      return reply.code(200).send({ connections });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/v1/composio/toolkits', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const query = optionalString(request.query as Record<string, unknown> | undefined, 'query');
      const limit = optionalNumber(request.query as Record<string, unknown> | undefined, 'limit');
      const toolkits = await deps.composioService.listToolkits(auth.user.id, { query, limit });
      return reply.code(200).send({ toolkits });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/connections/request', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const toolkit = requiredString(body, 'toolkit');
      const callbackUrl = requiredString(body, 'callbackUrl');
      const result = await deps.composioService.requestConnection(auth.user.id, toolkit, callbackUrl);
      return reply.code(201).send({ request: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/v1/composio/connections/requests/:id', async (request, reply) => {
    try {
      await deps.authService.authenticateAppSession(extractBearerToken(request));
      const { id } = request.params as { id: string };
      const result = await deps.composioService.getRequest(id);
      return reply.code(200).send({ request: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/actions/find', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const actions = await deps.composioService.findActions(auth.user.id, {
        app: optionalString(body, 'app'),
        intent: requiredString(body, 'intent'),
        limit: optionalNumber(body, 'limit'),
      });
      return reply.code(200).send({ actions });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/actions/schema', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const action = await deps.composioService.getActionSchema(
        auth.user.id,
        requiredString(body, 'providerAction'),
      );
      return reply.code(200).send({ action });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/v1/composio/actions/execute', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = await deps.composioService.executeAction(auth.user.id, {
        providerAction: requiredString(body, 'providerAction'),
        arguments: optionalRecord(body, 'arguments') ?? undefined,
      });
      return reply.code(200).send({ result });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) throw new AuthServiceError(401, 'missing_session', 'Missing Authorization header.');
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AuthServiceError(401, 'invalid_session', 'Authorization header must use Bearer token.');
  }
  return header.slice(7).trim();
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  if (error instanceof ComposioServiceError) {
    return reply.code(error.status).send({ error: 'composio_error', message: error.message });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ComposioServiceError(400, `Missing "${key}"`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(body: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = body?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalRecord(body: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = body[key];
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ComposioServiceError(400, `Invalid "${key}"`);
  }
  return value as Record<string, unknown>;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import {
  ModelProviderService,
  ModelProviderServiceError,
  parseModelProvider,
} from '../model-providers/service.ts';

const saveKeySchema = z.object({
  apiKey: z.string().trim().min(1),
});
const SAVE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SAVE_RATE_LIMIT_MAX = 10;
const saveAttempts = new Map<string, { count: number; resetAt: number }>();

export interface ModelProviderRouteDeps {
  authService: AuthService;
  modelProviderService: ModelProviderService;
}

export async function registerModelProviderRoutes(
  app: FastifyInstance,
  deps: ModelProviderRouteDeps,
): Promise<void> {
  app.get('/v1/model-providers', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const providers = await deps.modelProviderService.listConnections(auth.user.id);
      return reply.code(200).send({ providers });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put('/v1/model-providers/:provider', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const { provider: rawProvider } = request.params as { provider: string };
      const provider = parseModelProvider(rawProvider);
      checkSaveRateLimit(auth.user.id, provider);
      const body = saveKeySchema.parse(request.body ?? {});
      const connection = await deps.modelProviderService.saveProviderKey({
        userId: auth.user.id,
        provider,
        apiKey: body.apiKey,
      });
      return reply.code(200).send({ provider: connection });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/v1/model-providers/:provider', async (request, reply) => {
    try {
      const auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
      const { provider: rawProvider } = request.params as { provider: string };
      const provider = parseModelProvider(rawProvider);
      const connection = await deps.modelProviderService.removeProviderKey(auth.user.id, provider);
      return reply.code(200).send({ provider: connection });
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
  if (error instanceof ModelProviderServiceError) {
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: 'bad_request', message: 'Invalid model provider body.', issues: error.issues });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function checkSaveRateLimit(userId: string, provider: string): void {
  const now = Date.now();
  const key = `${userId}::${provider}`;
  const current = saveAttempts.get(key);
  if (!current || current.resetAt <= now) {
    saveAttempts.set(key, { count: 1, resetAt: now + SAVE_RATE_LIMIT_WINDOW_MS });
    return;
  }

  if (current.count >= SAVE_RATE_LIMIT_MAX) {
    throw new ModelProviderServiceError(
      429,
      'rate_limited',
      'Too many model provider key save attempts. Try again later.',
    );
  }

  current.count += 1;
  saveAttempts.set(key, current);
}

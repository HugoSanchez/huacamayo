import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError } from '../auth/service.ts';

const exchangeSchema = z.object({
  privyAccessToken: z.string().min(1),
  deviceLabel: z.string().trim().min(1).max(120).default('Vervo for macOS'),
  platform: z.string().trim().min(1).max(60).default('macos'),
  email: z.string().trim().email().optional().nullable(),
  displayName: z.string().trim().max(120).optional().nullable(),
});

export async function registerAuthRoutes(app: FastifyInstance, authService: AuthService): Promise<void> {
  app.post('/v1/auth/privy/exchange', async (request, reply) => {
    try {
      const body = exchangeSchema.parse(request.body ?? {});
      const result = await authService.exchangePrivyAuth(body);
      return reply.code(200).send({
        session: {
          token: result.sessionToken,
          expiresAt: result.session.expiresAt,
        },
        user: {
          id: result.user.id,
          privyUserId: result.user.privyUserId,
          email: result.user.email,
          displayName: result.user.displayName,
        },
        device: {
          id: result.device.id,
          label: result.device.deviceLabel,
          platform: result.device.platform,
        },
        entitlements: result.entitlements.map((item) => ({
          mode: item.mode,
          status: item.status,
          allowedModels: item.allowedModels,
        })),
      });
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.post('/v1/auth/revoke', async (request, reply) => {
    try {
      const sessionToken = extractBearerToken(request);
      await authService.revokeAppSession(sessionToken);
      return reply.code(204).send();
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });

  app.get('/v1/me', async (request, reply) => {
    try {
      const sessionToken = extractBearerToken(request);
      const auth = await authService.authenticateAppSession(sessionToken);
      return reply.code(200).send({
        user: {
          id: auth.user.id,
          privyUserId: auth.user.privyUserId,
          email: auth.user.email,
          displayName: auth.user.displayName,
        },
        device: {
          id: auth.device.id,
          label: auth.device.deviceLabel,
          platform: auth.device.platform,
          lastSeenAt: auth.device.lastSeenAt,
        },
        session: {
          id: auth.session.id,
          issuedAt: auth.session.issuedAt,
          expiresAt: auth.session.expiresAt,
        },
        entitlements: auth.entitlements.map((item) => ({
          id: item.id,
          mode: item.mode,
          status: item.status,
          allowedModels: item.allowedModels,
          monthlyUsdLimit: item.monthlyUsdLimit,
          dailyUsdLimit: item.dailyUsdLimit,
        })),
      });
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }
  });
}

function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header) {
    throw new AuthServiceError(401, 'missing_session', 'Missing Authorization header.');
  }
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AuthServiceError(401, 'invalid_session', 'Authorization header must use Bearer token.');
  }
  return header.slice(7).trim();
}

function handleAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthServiceError) {
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
    });
  }

  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: 'bad_request',
      message: 'Invalid request body.',
      issues: error.issues,
    });
  }

  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

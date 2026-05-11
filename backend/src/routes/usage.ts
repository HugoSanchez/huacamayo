import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import type { InferenceStore } from '../inference/types.ts';

export interface UsageRouteDeps {
  authService: AuthService;
  inferenceStore: InferenceStore;
}

export async function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): Promise<void> {
  app.get('/v1/usage/summary', async (request, reply) => {
    let auth;
    try {
      auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const totals = await deps.inferenceStore.getUserUsageTotals(auth.user.id, now);

    const managed = auth.entitlements.find((entitlement) =>
      entitlement.mode === 'managed' && entitlement.status === 'active');

    return reply.code(200).send({
      user: {
        id: auth.user.id,
        email: auth.user.email,
        displayName: auth.user.displayName,
      },
      mode: managed?.mode ?? 'managed',
      usage: {
        monthToDateUsd: totals.monthToDateUsd,
        dayToDateUsd: totals.dayToDateUsd,
        monthStart: monthStart.toISOString(),
        dayStart: dayStart.toISOString(),
      },
      limits: {
        monthlyUsdLimit: parseLimit(managed?.monthlyUsdLimit),
        dailyUsdLimit: parseLimit(managed?.dailyUsdLimit),
      },
    });
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
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

function parseLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

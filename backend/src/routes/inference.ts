import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import type { BackendConfig } from '../config.ts';
import { OpenRouterClient, OpenRouterError } from '../inference/openrouter.ts';
import type { InferenceStore } from '../inference/types.ts';
import { SlidingWindowRateLimiter } from '../inference/rate-limiter.ts';
import { FailureCircuitBreaker } from '../inference/circuit-breaker.ts';

// Permissive validation: we only enforce the two fields we *must* see (model
// for the allowlist check, messages for safety). Every other field —
// max_tokens, top_p, tools, response_format, reasoning, etc. — gets passed
// through to OpenRouter unchanged so this endpoint stays a true OpenAI-style
// chat/completions proxy. `localSessionId` is our internal hint.
const requestSchema = z.object({
  model: z.string().trim().min(1),
  messages: z.array(z.unknown()).min(1),
  localSessionId: z.string().trim().min(1).optional().nullable(),
}).passthrough();

export interface InferenceRouteDeps {
  config: BackendConfig;
  authService: AuthService;
  inferenceStore: InferenceStore;
  /** Override for tests. */
  buildClient?: (config: BackendConfig) => OpenRouterClient;
  /** Override for tests; otherwise built from config. */
  rateLimiter?: SlidingWindowRateLimiter;
  breaker?: FailureCircuitBreaker;
}

export async function registerInferenceRoutes(app: FastifyInstance, deps: InferenceRouteDeps): Promise<void> {
  const buildClient = deps.buildClient ?? defaultClientFactory;
  const rateLimiter = deps.rateLimiter ?? new SlidingWindowRateLimiter(deps.config.managedRateLimitPerMinute);
  const breaker = deps.breaker ?? new FailureCircuitBreaker(
    deps.config.managedBreakerThreshold,
    deps.config.managedBreakerCooldownMs,
  );

  app.post('/v1/chat/completions', async (request, reply) => {
    let auth;
    try {
      auth = await deps.authService.authenticateAppSession(extractBearerToken(request));
    } catch (error: unknown) {
      return handleAuthError(reply, error);
    }

    const parseResult = requestSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Invalid inference request body.',
        issues: parseResult.error.issues,
      });
    }
    const body = parseResult.data;

    if (!deps.config.managedAllowedModels.includes(body.model)) {
      return reply.code(403).send({
        error: 'model_not_allowed',
        message: `Model ${body.model} is not in the managed allowlist.`,
      });
    }

    if (!deps.config.openRouterConfigured) {
      return reply.code(503).send({
        error: 'openrouter_unconfigured',
        message: 'OpenRouter API key is not configured.',
      });
    }

    // Rate limit (cheap in-memory check before any DB work).
    const rateDecision = rateLimiter.check(auth.user.id);
    if (!rateDecision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(rateDecision.retryAfterMs / 1000));
      console.warn(JSON.stringify({
        event: 'rate_limit_exceeded',
        userId: auth.user.id,
        retryAfterMs: rateDecision.retryAfterMs,
      }));
      return reply
        .code(429)
        .header('Retry-After', String(retryAfterSec))
        .send({
          error: 'rate_limit_exceeded',
          message: `Too many requests. Retry in ${retryAfterSec}s.`,
          retryAfterMs: rateDecision.retryAfterMs,
        });
    }

    // Circuit breaker: pause users whose recent calls are all failing.
    const breakerDecision = breaker.check(auth.user.id);
    if (!breakerDecision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(breakerDecision.cooldownRemainingMs / 1000));
      console.warn(JSON.stringify({
        event: 'circuit_breaker_open',
        userId: auth.user.id,
        cooldownRemainingMs: breakerDecision.cooldownRemainingMs,
      }));
      return reply
        .code(503)
        .header('Retry-After', String(retryAfterSec))
        .send({
          error: 'auto_paused',
          message: `Too many consecutive failures. Auto-paused for ${retryAfterSec}s.`,
          cooldownRemainingMs: breakerDecision.cooldownRemainingMs,
        });
    }

    // Spend-limit enforcement. We refuse the request *before* writing a
    // pending row so an over-limit user doesn't accumulate failed-cost rows.
    // Pending/failed rows have null cost and are excluded from the totals;
    // only completed requests with a real estimated_cost_usd count.
    const managedEntitlement = auth.entitlements.find((entitlement) =>
      entitlement.mode === 'managed' && entitlement.status === 'active');
    const monthlyLimit = parseLimit(managedEntitlement?.monthlyUsdLimit);
    const dailyLimit = parseLimit(managedEntitlement?.dailyUsdLimit);
    if (monthlyLimit !== null || dailyLimit !== null) {
      const totals = await deps.inferenceStore.getUserUsageTotals(auth.user.id, new Date());
      if (monthlyLimit !== null && totals.monthToDateUsd >= monthlyLimit) {
        return reply.code(402).send({
          error: 'spend_limit_exceeded',
          message: `Monthly spend limit of $${monthlyLimit.toFixed(2)} reached.`,
          scope: 'monthly',
          limit: monthlyLimit,
          used: totals.monthToDateUsd,
        });
      }
      if (dailyLimit !== null && totals.dayToDateUsd >= dailyLimit) {
        return reply.code(402).send({
          error: 'spend_limit_exceeded',
          message: `Daily spend limit of $${dailyLimit.toFixed(2)} reached.`,
          scope: 'daily',
          limit: dailyLimit,
          used: totals.dayToDateUsd,
        });
      }
    }

    const recordId = createId('inf');
    const startedAtIso = new Date().toISOString();
    await deps.inferenceStore.insertRequest({
      id: recordId,
      userId: auth.user.id,
      deviceId: auth.device.id,
      localSessionId: body.localSessionId ?? null,
      provider: 'openrouter',
      model: body.model,
      requestStartedAt: startedAtIso,
      requestCompletedAt: null,
      status: 'pending',
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      estimatedCostUsd: null,
      providerRequestId: null,
      errorCode: null,
    });

    const client = buildClient(deps.config);

    // Forward everything except our internal localSessionId hint. The client
    // re-injects stream=true / stream_options / provider policy.
    const forwardBody: Record<string, unknown> = { ...(body as Record<string, unknown>) };
    delete forwardBody.localSessionId;

    // Defensive cap: if the caller didn't budget output, inject our default so
    // we never accidentally request a model's full max_completion_tokens
    // (gpt-5.4 defaults to 65536, ~$1 of output per request without this).
    // The caller can always set max_tokens higher to override.
    if (forwardBody.max_tokens === undefined && forwardBody.maxTokens === undefined) {
      forwardBody.max_tokens = deps.config.managedDefaultMaxTokens;
    }

    let stream;
    try {
      stream = await client.streamChatCompletion(forwardBody);
    } catch (error: unknown) {
      const completedAt = new Date().toISOString();
      breaker.recordFailure(auth.user.id);
      if (error instanceof OpenRouterError) {
        await deps.inferenceStore.markFailed(recordId, completedAt, error.code);
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      await deps.inferenceStore.markFailed(recordId, completedAt, 'internal_error');
      return reply.code(500).send({ error: 'internal_error', message });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Inference-Request-Id': recordId,
    });

    const reader = stream.body.getReader();
    let upstreamFailed = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) raw.write(value);
      }
    } catch (error) {
      upstreamFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      try {
        raw.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_interrupted', message })}\n\n`);
      } catch { /* socket may already be closed */ }
    } finally {
      raw.end();
    }

    const completedAt = new Date().toISOString();
    if (upstreamFailed) {
      breaker.recordFailure(auth.user.id);
      await deps.inferenceStore.markFailed(recordId, completedAt, 'stream_interrupted');
      return;
    }

    breaker.recordSuccess(auth.user.id);
    const usage = await stream.usagePromise;
    await deps.inferenceStore.markCompleted(recordId, completedAt, usage);
  });
}

function defaultClientFactory(config: BackendConfig): OpenRouterClient {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }
  return new OpenRouterClient({
    apiKey: config.OPENROUTER_API_KEY,
    appUrl: config.WEB_BASE_URL ?? undefined,
    appTitle: 'Vervo',
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

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

/**
 * Entitlement limits are stored as nullable strings (text columns in Drizzle).
 * Empty/null/non-numeric values mean "no limit" — return null so the route
 * skips enforcement entirely instead of treating it as $0.
 */
function parseLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthServiceError } from '../auth/service.ts';
import type { BackendConfig } from '../config.ts';
import { OpenRouterClient, OpenRouterError } from '../inference/openrouter.ts';
import type { InferenceStore } from '../inference/types.ts';

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
}

export async function registerInferenceRoutes(app: FastifyInstance, deps: InferenceRouteDeps): Promise<void> {
  const buildClient = deps.buildClient ?? defaultClientFactory;

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
      await deps.inferenceStore.markFailed(recordId, completedAt, 'stream_interrupted');
      return;
    }

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

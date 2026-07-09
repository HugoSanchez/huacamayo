import { json, route, type Route } from './router.ts';
import {
  ManagedBackendClient,
  ManagedBackendError,
  type ModelProvider,
} from '../integrations/managed-backend-client.ts';

export function buildModelProviderRoutes(managedBackend: ManagedBackendClient): Route[] {
  return [
    route('GET', '/model-providers', async (_req, res) => {
      try {
        const providers = await managedBackend.listModelProviders();
        json(res, 200, { providers });
      } catch (error) {
        handleError(res, error);
      }
    }),

    route('PUT', '/model-providers/:provider', async (_req, res, params, body) => {
      try {
        const provider = parseProvider(params.provider);
        const apiKey = parseApiKey(body);
        const connection = await managedBackend.saveModelProviderKey(provider, apiKey);
        json(res, 200, { provider: connection });
      } catch (error) {
        handleError(res, error);
      }
    }),

    route('DELETE', '/model-providers/:provider', async (_req, res, params) => {
      try {
        const provider = parseProvider(params.provider);
        const connection = await managedBackend.deleteModelProviderKey(provider);
        json(res, 200, { provider: connection });
      } catch (error) {
        handleError(res, error);
      }
    }),
  ];
}

function parseProvider(value: string | undefined): ModelProvider {
  if (value === 'openai' || value === 'anthropic') return value;
  throw new ManagedBackendError(400, 'invalid_provider', 'Provider must be "openai" or "anthropic".');
}

function parseApiKey(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new ManagedBackendError(400, 'bad_request', 'Invalid model provider payload.');
  }
  const apiKey = (body as Record<string, unknown>).apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new ManagedBackendError(400, 'invalid_api_key', 'API key must not be empty.');
  }
  return apiKey.trim();
}

function handleError(res: Parameters<typeof json>[0], error: unknown): void {
  if (error instanceof ManagedBackendError) {
    json(res, error.status, { error: error.code, message: error.message });
    return;
  }
  json(res, 500, {
    error: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  });
}

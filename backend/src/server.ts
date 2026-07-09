import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig, type BackendConfig } from './config.ts';
import { AuthService } from './auth/service.ts';
import { MemoryAuthStore } from './auth/memory-store.ts';
import type { AuthStore } from './auth/types.ts';
import { BackendPrivyVerifier } from './auth/privy.ts';
import { DrizzleAuthStore } from './db/auth-store.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerComposioRoutes } from './routes/composio.ts';
import { registerAnalyticsRoutes } from './routes/analytics.ts';
import { ComposioService } from './composio/service.ts';
import { registerModelProviderRoutes } from './routes/model-providers.ts';
import {
  DrizzleModelProviderConnectionStore,
  EnvCentaurInstanceResolver,
  MemoryModelProviderConnectionStore,
  ModelProviderService,
  type CentaurInstanceResolver,
  type ModelProviderConnectionStore,
} from './model-providers/service.ts';

export interface BuildServerOptions {
  config?: BackendConfig;
  authService?: AuthService;
  authStore?: AuthStore;
  composioService?: ComposioService;
  modelProviderStore?: ModelProviderConnectionStore;
  centaurInstanceResolver?: CentaurInstanceResolver;
  modelProviderService?: ModelProviderService;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? getConfig();
  const app = Fastify({
    logger: config.NODE_ENV === 'development'
      ? {
        redact: [
          'req.headers.authorization',
          'req.body.apiKey',
          'req.body.openaiApiKey',
          'req.body.anthropicApiKey',
          'req.body.secret',
          'req.body.token',
          'req.query.apiKey',
          'req.query.openaiApiKey',
          'req.query.anthropicApiKey',
          'req.query.secret',
          'req.query.token',
        ],
      }
      : false,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  const authStore = options.authStore ?? defaultAuthStore(config);

  const authService = options.authService ?? new AuthService(
    config,
    authStore,
    config.privyConfigured ? new BackendPrivyVerifier(config) : null,
  );

  await registerHealthRoutes(app, config);
  await registerAuthRoutes(app, authService);
  const composioService = options.composioService ?? new ComposioService();
  await registerComposioRoutes(app, { authService, composioService });
  const modelProviderStore = options.modelProviderStore ?? defaultModelProviderStore(config);
  const centaurInstanceResolver = options.centaurInstanceResolver ?? new EnvCentaurInstanceResolver(config);
  const modelProviderService = options.modelProviderService
    ?? new ModelProviderService(modelProviderStore, centaurInstanceResolver);
  await registerModelProviderRoutes(app, { authService, modelProviderService });
  await registerAnalyticsRoutes(app, { authService, config });
  return app;
}

function defaultAuthStore(config: BackendConfig): AuthStore {
  if (config.databaseConfigured && config.DATABASE_URL) {
    return new DrizzleAuthStore(config.DATABASE_URL);
  }
  return new MemoryAuthStore();
}

function defaultModelProviderStore(config: BackendConfig): ModelProviderConnectionStore {
  if (config.databaseConfigured && config.DATABASE_URL) {
    return new DrizzleModelProviderConnectionStore(config.DATABASE_URL);
  }
  return new MemoryModelProviderConnectionStore();
}

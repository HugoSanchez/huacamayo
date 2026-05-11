import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig, type BackendConfig } from './config.ts';
import { AuthService } from './auth/service.ts';
import { MemoryAuthStore } from './auth/memory-store.ts';
import type { AuthStore } from './auth/types.ts';
import { BackendPrivyVerifier } from './auth/privy.ts';
import { DrizzleAuthStore } from './db/auth-store.ts';
import { DrizzleInferenceStore } from './db/inference-store.ts';
import { MemoryInferenceStore } from './inference/memory-store.ts';
import type { InferenceStore } from './inference/types.ts';
import type { OpenRouterClient } from './inference/openrouter.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerRuntimeConfigRoutes } from './routes/runtime-config.ts';
import { registerInferenceRoutes } from './routes/inference.ts';

export interface BuildServerOptions {
  config?: BackendConfig;
  authService?: AuthService;
  authStore?: AuthStore;
  inferenceStore?: InferenceStore;
  buildOpenRouterClient?: (config: BackendConfig) => OpenRouterClient;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = options.config ?? getConfig();
  const app = Fastify({
    logger: config.NODE_ENV === 'development',
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  const authStore = options.authStore ?? defaultAuthStore(config);
  const inferenceStore = options.inferenceStore ?? defaultInferenceStore(config);

  const authService = options.authService ?? new AuthService(
    config,
    authStore,
    config.privyConfigured ? new BackendPrivyVerifier(config) : null,
  );

  await registerHealthRoutes(app, config);
  await registerAuthRoutes(app, authService);
  await registerRuntimeConfigRoutes(app, config);
  await registerInferenceRoutes(app, {
    config,
    authService,
    inferenceStore,
    buildClient: options.buildOpenRouterClient,
  });
  return app;
}

function defaultAuthStore(config: BackendConfig): AuthStore {
  if (config.databaseConfigured && config.DATABASE_URL) {
    return new DrizzleAuthStore(config.DATABASE_URL);
  }
  return new MemoryAuthStore();
}

function defaultInferenceStore(config: BackendConfig): InferenceStore {
  if (config.databaseConfigured && config.DATABASE_URL) {
    return new DrizzleInferenceStore(config.DATABASE_URL);
  }
  return new MemoryInferenceStore();
}

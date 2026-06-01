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

export interface BuildServerOptions {
  config?: BackendConfig;
  authService?: AuthService;
  authStore?: AuthStore;
  composioService?: ComposioService;
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

  const authService = options.authService ?? new AuthService(
    config,
    authStore,
    config.privyConfigured ? new BackendPrivyVerifier(config) : null,
  );

  await registerHealthRoutes(app, config);
  await registerAuthRoutes(app, authService);
  const composioService = options.composioService ?? new ComposioService();
  await registerComposioRoutes(app, { authService, composioService });
  await registerAnalyticsRoutes(app, { authService, config });
  return app;
}

function defaultAuthStore(config: BackendConfig): AuthStore {
  if (config.databaseConfigured && config.DATABASE_URL) {
    return new DrizzleAuthStore(config.DATABASE_URL);
  }
  return new MemoryAuthStore();
}

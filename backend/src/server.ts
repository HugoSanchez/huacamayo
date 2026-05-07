import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig, type BackendConfig } from './config.ts';
import { AuthService } from './auth/service.ts';
import { MemoryAuthStore } from './auth/memory-store.ts';
import { BackendPrivyVerifier } from './auth/privy.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerAuthRoutes } from './routes/auth.ts';

export interface BuildServerOptions {
  config?: BackendConfig;
  authService?: AuthService;
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

  const authService = options.authService ?? new AuthService(
    config,
    new MemoryAuthStore(),
    config.privyConfigured ? new BackendPrivyVerifier(config) : null,
  );

  await registerHealthRoutes(app, config);
  await registerAuthRoutes(app, authService);
  return app;
}

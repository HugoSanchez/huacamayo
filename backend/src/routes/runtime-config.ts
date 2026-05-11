import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../config.ts';

export async function registerRuntimeConfigRoutes(app: FastifyInstance, config: BackendConfig): Promise<void> {
  app.get('/v1/runtime-config', async (_request, reply) => {
    return reply.code(200).send({
      defaultModel: config.managedDefaultModel,
      allowedModels: config.managedAllowedModels,
    });
  });
}

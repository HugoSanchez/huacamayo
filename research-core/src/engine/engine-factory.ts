import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';

/**
 * Create a PGLite engine instance.
 * Vervo only supports PGLite (local-first).
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const { PGLiteEngine } = await import('./pglite-engine.ts');
  return new PGLiteEngine();
}

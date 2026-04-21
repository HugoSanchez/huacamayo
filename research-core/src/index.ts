/**
 * research-core — Local research sidecar for Vervo
 *
 * Provides: indexing, hybrid retrieval, knowledge graph, and MCP server.
 * Engine derived from gbrain (PGLiteEngine), adapted for local-first research.
 */

export { PGLiteEngine } from './engine/pglite-engine.ts';
export { createEngine } from './engine/engine-factory.ts';
export type { BrainEngine } from './engine/engine.ts';
export type { Source, SourceInput, Context, ContextInput } from './engine/types.ts';
export type { VervoConfig } from './engine/config.ts';
export { loadConfig, saveConfig, toEngineConfig, configDir } from './engine/config.ts';
export { operations, operationsByName } from './engine/operations.ts';
export { startServer } from './http/server.ts';
export { hybridSearch } from './engine/search/hybrid.ts';
export { importFromContent, importFromFile } from './engine/import-file.ts';
export {
  embed, embedBatch, dispose as disposeEmbedding,
  isAvailable as embeddingAvailable, isLoaded as embeddingLoaded,
  setModelPath, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
} from './engine/embedding.ts';
export {
  rerank, disposeReranker,
  isRerankerAvailable, isRerankerLoaded,
  setRerankerModelPath, RERANKER_MODEL,
} from './engine/search/rerank.ts';
export { createMcpServer, startMcpServer } from './mcp/server.ts';

/**
 * Embedding Service — Stub
 *
 * This is a placeholder. The real local embedding implementation
 * (node-llama-cpp + embeddinggemma-300M) will be added in Phase 1, Step 2.
 *
 * For now, embedBatch returns zero vectors so the engine can compile and
 * run without embeddings (keyword-only search works).
 */

export const EMBEDDING_MODEL = 'embeddinggemma-300M';
export const EMBEDDING_DIMENSIONS = 768;

export async function embed(text: string): Promise<Float32Array> {
  const result = await embedBatch([text]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // TODO: Replace with local GGUF embedding via node-llama-cpp
  console.warn(`[research-core] embedding stub called for ${texts.length} texts — returning zero vectors`);
  return texts.map(() => new Float32Array(EMBEDDING_DIMENSIONS));
}

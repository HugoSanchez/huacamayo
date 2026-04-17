/**
 * Query Expansion — Stub
 *
 * This is a placeholder. The real local implementation
 * (node-llama-cpp + qwen3-query-expansion) will be added later.
 *
 * For now, expandQuery returns the original query unchanged.
 */

export async function expandQuery(query: string): Promise<string[]> {
  // TODO: Replace with local GGUF query expansion
  return [query];
}

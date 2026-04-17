import { describe, it, expect, afterAll } from 'vitest';
import {
  embed, embedBatch, dispose, isAvailable, isLoaded,
  EMBEDDING_DIMENSIONS,
} from '../src/engine/embedding.ts';

/**
 * Embedding integration tests.
 *
 * These require the GGUF model file to be present.
 * If the model isn't installed, the suite skips gracefully.
 */
const HAS_MODEL = isAvailable();

describe.skipIf(!HAS_MODEL)('Local Embedding (bge-m3)', () => {
  afterAll(async () => {
    await dispose();
  }, 30_000);

  it('produces a 1024-dim Float32Array', async () => {
    const vec = await embed('The transformer architecture uses self-attention.');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIMENSIONS);
  }, 30_000);

  it('produces non-zero vectors', async () => {
    const vec = await embed('Hello world');
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeGreaterThan(0);
  });

  it('is deterministic (same input → same output)', async () => {
    const text = 'Attention is all you need.';
    const v1 = await embed(text);
    const v2 = await embed(text);
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it('embedBatch returns correct count', async () => {
    const texts = ['First document.', 'Second document.', 'Third document.'];
    const vecs = await embedBatch(texts);
    expect(vecs.length).toBe(3);
    for (const v of vecs) {
      expect(v.length).toBe(EMBEDDING_DIMENSIONS);
    }
  });

  it('embedBatch handles empty array', async () => {
    const vecs = await embedBatch([]);
    expect(vecs.length).toBe(0);
  });

  it('similar texts have higher cosine similarity than unrelated texts', async () => {
    const [vAttention, vTransformer, vCooking] = await embedBatch([
      'The attention mechanism in neural networks',
      'Transformer models use multi-head attention',
      'Boil water and add pasta for 8 minutes',
    ]);

    const simRelated = cosine(vAttention, vTransformer);
    const simUnrelated = cosine(vAttention, vCooking);

    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it('model is loaded after first embed', () => {
    expect(isLoaded()).toBe(true);
  });

  it('dispose unloads the model', async () => {
    await dispose();
    expect(isLoaded()).toBe(false);
  });
});

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

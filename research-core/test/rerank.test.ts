import { describe, it, expect, afterAll } from 'vitest';
import {
  rerank, disposeReranker, isRerankerAvailable, isRerankerLoaded,
  blendScores, type RerankInput,
} from '../src/engine/search/rerank.ts';
import type { SearchResult } from '../src/engine/types.ts';

const HAS_MODEL = isRerankerAvailable();

function fakeResult(slug: string, text: string, score: number): SearchResult {
  return {
    slug,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    score,
    chunk_id: null as any,
    page_title: slug,
  };
}

describe('blendScores (pure, no model needed)', () => {
  it('blends RRF and reranker scores with position-aware weighting', () => {
    const rrfResults = [
      fakeResult('a', 'doc a', 1.0),   // rank 0 → 75% RRF
      fakeResult('b', 'doc b', 0.8),   // rank 1 → 75% RRF
      fakeResult('c', 'doc c', 0.6),   // rank 2 → 75% RRF
      fakeResult('d', 'doc d', 0.4),   // rank 3 → 60% RRF
    ];

    const rerankScores = new Map([
      ['a:doc a', 0.2],  // low rerank score
      ['b:doc b', 0.9],  // high rerank score
      ['c:doc c', 0.5],
      ['d:doc d', 0.95], // highest rerank score but rank 3+
    ]);

    const blended = blendScores(rrfResults, rerankScores);
    expect(blended.length).toBe(4);

    // All results should have blended scores
    for (const r of blended) {
      expect(r.score).toBeGreaterThan(0);
    }

    // Results should be re-sorted by blended score
    for (let i = 1; i < blended.length; i++) {
      expect(blended[i - 1].score).toBeGreaterThanOrEqual(blended[i].score);
    }
  });

  it('passes through results missing from rerank scores', () => {
    const rrfResults = [fakeResult('a', 'doc a', 1.0)];
    const rerankScores = new Map<string, number>(); // empty

    const blended = blendScores(rrfResults, rerankScores);
    expect(blended.length).toBe(1);
    expect(blended[0].score).toBe(1.0); // unchanged
  });
});

describe.skipIf(!HAS_MODEL)('Reranker (Qwen3-Reranker-0.6B)', () => {
  afterAll(async () => {
    await disposeReranker();
  }, 30_000);

  it('scores relevant document higher than irrelevant', async () => {
    const query = 'How does the transformer architecture work?';
    const inputs: RerankInput[] = [
      { text: 'Boil water, add pasta, cook for 8 minutes.', result: fakeResult('cooking', 'pasta', 0.5) },
      { text: 'The transformer uses self-attention to process input sequences in parallel.', result: fakeResult('attention', 'transformer', 0.5) },
    ];

    const results = await rerank(query, inputs);
    expect(results.length).toBe(2);

    // Transformer doc should score higher
    expect(results[0].result.slug).toBe('attention');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  }, 30_000);

  it('returns scores between 0 and 1', async () => {
    const results = await rerank('What is deep learning?', [
      { text: 'Deep learning uses neural networks with many layers.', result: fakeResult('dl', 'deep learning', 0.5) },
    ]);

    expect(results[0].score).toBeGreaterThanOrEqual(0);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });

  it('handles empty input', async () => {
    const results = await rerank('query', []);
    expect(results.length).toBe(0);
  });

  it('model is loaded after first rerank', () => {
    expect(isRerankerLoaded()).toBe(true);
  });

  it('dispose unloads the model', async () => {
    await disposeReranker();
    expect(isRerankerLoaded()).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { EMBEDDING_DIMENSIONS } from '../src/engine/embedding.ts';

describe('Search', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    // Create pages WITH chunks so keyword search can find them
    await engine.putPage('papers/attention', {
      type: 'concept',
      title: 'Attention Is All You Need',
      compiled_truth: 'The transformer architecture relies on self-attention mechanisms.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('papers/attention', [
      {
        chunk_index: 0,
        chunk_text: 'The transformer architecture relies on self-attention mechanisms to process sequences in parallel.',
        chunk_source: 'compiled_truth',
      },
    ]);

    await engine.putPage('papers/bert', {
      type: 'concept',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      compiled_truth: 'BERT uses masked language modeling for pre-training.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('papers/bert', [
      {
        chunk_index: 0,
        chunk_text: 'BERT uses masked language modeling for pre-training deep bidirectional transformers.',
        chunk_source: 'compiled_truth',
      },
    ]);

    await engine.putPage('notes/cooking', {
      type: 'concept',
      title: 'Pasta Recipe',
      compiled_truth: 'Boil water, add pasta, cook for 8 minutes.',
      timeline: '',
      frontmatter: {},
    });
    await engine.upsertChunks('notes/cooking', [
      {
        chunk_index: 0,
        chunk_text: 'Boil water, add pasta, cook for 8 minutes. Season with salt and olive oil.',
        chunk_source: 'compiled_truth',
      },
    ]);
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  describe('keyword search', () => {
    it('finds pages by keyword', async () => {
      const results = await engine.searchKeyword('transformer');
      expect(results.length).toBeGreaterThan(0);
      const slugs = results.map(r => r.slug);
      expect(slugs).toContain('papers/attention');
    });

    it('returns relevant results ranked by score', async () => {
      const results = await engine.searchKeyword('transformer attention');
      expect(results.length).toBeGreaterThan(0);
      // The attention paper should rank highest for "transformer attention"
      expect(results[0].slug).toBe('papers/attention');
    });

    it('does not return unrelated pages', async () => {
      const results = await engine.searchKeyword('transformer');
      const slugs = results.map(r => r.slug);
      expect(slugs).not.toContain('notes/cooking');
    });

    it('returns empty for gibberish query', async () => {
      const results = await engine.searchKeyword('xyzzyplugh');
      expect(results.length).toBe(0);
    });

    it('respects limit parameter', async () => {
      const results = await engine.searchKeyword('transformer', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('vector search', () => {
    it('accepts a float32 embedding and returns results', async () => {
      // Store a chunk with a real embedding first
      const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
      embedding[0] = 1.0; // non-zero so cosine similarity works

      await engine.upsertChunks('papers/attention', [
        {
          chunk_index: 0,
          chunk_text: 'The transformer architecture relies on self-attention.',
          chunk_source: 'compiled_truth',
          embedding,
        },
      ]);

      const results = await engine.searchVector(embedding);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].slug).toBe('papers/attention');
    });
  });
});

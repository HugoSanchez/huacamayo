import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { EMBEDDING_DIMENSIONS } from '../src/engine/embedding.ts';

describe('Chunks', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    await engine.putPage('test/chunked-page', {
      type: 'concept',
      title: 'Chunked Page',
      compiled_truth: 'A page that will have chunks.',
      timeline: '',
      frontmatter: {},
    });
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  describe('upsertChunks', () => {
    it('inserts chunks for a page', async () => {
      await engine.upsertChunks('test/chunked-page', [
        { chunk_index: 0, chunk_text: 'First paragraph of content.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'Second paragraph of content.', chunk_source: 'compiled_truth' },
        { chunk_index: 2, chunk_text: 'Timeline entry content.', chunk_source: 'timeline' },
      ]);

      const chunks = await engine.getChunks('test/chunked-page');
      expect(chunks.length).toBe(3);
      expect(chunks[0].chunk_text).toBe('First paragraph of content.');
      expect(chunks[1].chunk_index).toBe(1);
      expect(chunks[2].chunk_source).toBe('timeline');
    });

    it('inserts chunks with embeddings', async () => {
      const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
      embedding[0] = 0.5;
      embedding[1] = 0.3;

      await engine.upsertChunks('test/chunked-page', [
        {
          chunk_index: 0,
          chunk_text: 'Content with embedding.',
          chunk_source: 'compiled_truth',
          embedding,
          token_count: 4,
        },
      ]);

      const chunks = await engine.getChunksWithEmbeddings('test/chunked-page');
      expect(chunks.length).toBe(1);
      expect(chunks[0].embedding).not.toBeNull();
      expect(chunks[0].token_count).toBe(4);
    });

    it('replaces chunks on re-upsert', async () => {
      await engine.upsertChunks('test/chunked-page', [
        { chunk_index: 0, chunk_text: 'Original chunk.', chunk_source: 'compiled_truth' },
        { chunk_index: 1, chunk_text: 'Will be removed.', chunk_source: 'compiled_truth' },
      ]);

      // Re-upsert with only one chunk — chunk_index 1 should be deleted
      await engine.upsertChunks('test/chunked-page', [
        { chunk_index: 0, chunk_text: 'Updated chunk.', chunk_source: 'compiled_truth' },
      ]);

      const chunks = await engine.getChunks('test/chunked-page');
      expect(chunks.length).toBe(1);
      expect(chunks[0].chunk_text).toBe('Updated chunk.');
    });
  });

  describe('deleteChunks', () => {
    it('removes all chunks for a page', async () => {
      await engine.upsertChunks('test/chunked-page', [
        { chunk_index: 0, chunk_text: 'Some content.', chunk_source: 'compiled_truth' },
      ]);

      await engine.deleteChunks('test/chunked-page');
      const chunks = await engine.getChunks('test/chunked-page');
      expect(chunks.length).toBe(0);
    });
  });
});

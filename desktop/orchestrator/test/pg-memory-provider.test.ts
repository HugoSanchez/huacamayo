import { describe, expect, it } from 'vitest';
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  MAX_CHUNKS_PER_ROW,
  chunkForEmbedding,
  laterIso,
  mergeContent,
  vectorLiteral,
} from '../src/memoryd/pg-memory-provider.ts';

describe('chunkForEmbedding', () => {
  it('returns one chunk for short content, title prepended', () => {
    expect(chunkForEmbedding('Title', 'body')).toEqual(['Title\nbody']);
  });

  it('windows long content with overlap and caps chunk count', () => {
    const text = 'x'.repeat(CHUNK_CHARS * 12);
    const chunks = chunkForEmbedding(null, text);
    expect(chunks.length).toBe(MAX_CHUNKS_PER_ROW);
    expect(chunks[0].length).toBe(CHUNK_CHARS);
    // Consecutive windows advance by CHUNK_CHARS - CHUNK_OVERLAP.
    const step = CHUNK_CHARS - CHUNK_OVERLAP;
    expect(chunks[1]).toBe(text.slice(step, step + CHUNK_CHARS));
  });
});

describe('mergeContent', () => {
  it('appends with a newline', () => {
    expect(mergeContent('a', 'b')).toBe('a\nb');
    expect(mergeContent('', 'b')).toBe('b');
  });

  it('keeps the most-recent tail when over the cap', () => {
    const merged = mergeContent('old '.repeat(10_000), 'FRESH');
    expect(merged.length).toBeLessThanOrEqual(20_000 + '…[earlier truncated]\n'.length);
    expect(merged.startsWith('…[earlier truncated]\n')).toBe(true);
    expect(merged.endsWith('FRESH')).toBe(true);
  });
});

describe('laterIso', () => {
  it('picks the later ISO timestamp and tolerates nulls', () => {
    expect(laterIso('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toBe('2026-02-01T00:00:00Z');
    expect(laterIso(null, '2026-02-01T00:00:00Z')).toBe('2026-02-01T00:00:00Z');
    expect(laterIso('2026-01-01T00:00:00Z', null)).toBe('2026-01-01T00:00:00Z');
    expect(laterIso(null, null)).toBeNull();
  });
});

describe('vectorLiteral', () => {
  it('renders a pgvector-parseable literal', () => {
    const literal = vectorLiteral(new Float32Array([0.5, -1, 0.25]));
    expect(literal).toBe('[0.5,-1,0.25]');
  });
});

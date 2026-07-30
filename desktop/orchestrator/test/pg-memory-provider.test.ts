import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  MAX_CHUNKS_PER_ROW,
  chunkForEmbedding,
  laterIso,
  mergeContent,
  vectorLiteral,
} from '../src/memoryd/pg-memory-provider.ts';
import { createMemorydServer, identitySlugsFromEnv, renderIdentityPrompt } from '../src/memoryd/server.ts';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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

describe('identity prompt rendering', () => {
  it('uses default identity slugs unless overridden', () => {
    expect(identitySlugsFromEnv('')).toEqual(['identity/agent', 'identity/user']);
    expect(identitySlugsFromEnv(' identity/user, profile/hugo ,, identity/agent ')).toEqual([
      'identity/user',
      'profile/hugo',
      'identity/agent',
    ]);
  });

  it('renders non-empty pages in slug order with the maintenance pointer', () => {
    const prompt = renderIdentityPrompt([
      {
        slug: 'identity/agent',
        title: 'Agent identity',
        content: 'Operate tersely.',
        updated_at: '2026-07-30T00:00:00Z',
      },
      {
        slug: 'identity/user',
        title: 'User identity',
        content: 'Hugo is not a lawyer.',
        updated_at: '2026-07-30T00:00:00Z',
      },
    ]);

    expect(prompt).toContain('## Who you are working for');
    expect(prompt).toContain('Operate tersely.\n\nHugo is not a lawyer.');
    expect(prompt).toContain('memory pages identity/agent, identity/user');
    expect(prompt).toContain('memory tool');
  });

  it('returns null for absent or blank identity content', () => {
    expect(renderIdentityPrompt([])).toBeNull();
    expect(
      renderIdentityPrompt([
        { slug: 'identity/user', title: null, content: '   ', updated_at: '2026-07-30T00:00:00Z' },
      ]),
    ).toBeNull();
  });

  it('caps the rendered prompt and marks truncation', () => {
    const prompt = renderIdentityPrompt(
      [{ slug: 'identity/user', title: null, content: 'x'.repeat(200), updated_at: '2026-07-30T00:00:00Z' }],
      120,
    );

    expect(prompt).not.toBeNull();
    expect(prompt!.length).toBe(120);
    expect(prompt!.endsWith('…[truncated]')).toBe(true);
  });

  it('serves /identity as text/plain and 204s when empty', async () => {
    const port = await serveMemorydIdentity([
      { slug: 'identity/agent', title: null, content: 'Operate tersely.', updated_at: '2026-07-30T00:00:00Z' },
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/identity`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toContain('Operate tersely.');

    const emptyPort = await serveMemorydIdentity([]);
    const emptyRes = await fetch(`http://127.0.0.1:${emptyPort}/identity`);
    expect(emptyRes.status).toBe(204);
    expect(await emptyRes.text()).toBe('');
  });
});

async function serveMemorydIdentity(pages: Parameters<typeof renderIdentityPrompt>[0]): Promise<number> {
  const server = createMemorydServer({
    provider: { getPagesBySlugs: async () => pages },
    embedder: {},
    scheduler: {},
  } as Parameters<typeof createMemorydServer>[0]);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

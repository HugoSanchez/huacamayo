import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { importFromContent } from '../src/engine/import-file.ts';

describe('Import pipeline', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  it('imports markdown content with frontmatter', async () => {
    const content = `---
type: concept
title: Attention Mechanism
tags: [transformer, nlp]
---
The attention mechanism allows models to focus on relevant parts of the input.

It was introduced in the paper "Attention Is All You Need".
`;

    const result = await importFromContent(engine, 'concepts/attention', content, { noEmbed: true });
    expect(result.status).toBe('imported');
    expect(result.slug).toBe('concepts/attention');
    expect(result.chunks).toBeGreaterThan(0);

    const page = await engine.getPage('concepts/attention');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Attention Mechanism');
    expect(page!.type).toBe('concept');

    const tags = await engine.getTags('concepts/attention');
    expect(tags).toContain('transformer');
    expect(tags).toContain('nlp');

    const chunks = await engine.getChunks('concepts/attention');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('skips re-import of identical content (idempotent)', async () => {
    const content = `---
title: Test Page
---
Some content.
`;

    const first = await importFromContent(engine, 'test/idempotent', content, { noEmbed: true });
    expect(first.status).toBe('imported');

    const second = await importFromContent(engine, 'test/idempotent', content, { noEmbed: true });
    expect(second.status).toBe('skipped');
  });

  it('updates page when content changes', async () => {
    const v1 = `---
title: Evolving Page
---
Version one content.
`;
    const v2 = `---
title: Evolving Page Updated
---
Version two content with more detail.
`;

    await importFromContent(engine, 'test/evolving', v1, { noEmbed: true });
    const result = await importFromContent(engine, 'test/evolving', v2, { noEmbed: true });
    expect(result.status).toBe('imported');

    const page = await engine.getPage('test/evolving');
    expect(page!.title).toBe('Evolving Page Updated');
    expect(page!.compiled_truth).toContain('Version two');
  });

  it('handles content with timeline section', async () => {
    const content = `---
title: Person Page
type: person
---
Alice is a researcher in NLP.

---

2023-01-15: Published a paper on transformers.
2024-03-01: Joined OpenAI.
`;

    const result = await importFromContent(engine, 'people/alice', content, { noEmbed: true });
    expect(result.status).toBe('imported');

    const page = await engine.getPage('people/alice');
    expect(page!.compiled_truth).toContain('Alice is a researcher');
    expect(page!.timeline).toContain('Published a paper');
  });

  it('rejects oversized content', async () => {
    const huge = 'x'.repeat(6_000_000);
    const result = await importFromContent(engine, 'test/too-big', huge, { noEmbed: true });
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('too large');
  });

  it('handles plain markdown without frontmatter', async () => {
    const content = `# Simple Note

Just a plain markdown file with no YAML frontmatter.
`;

    const result = await importFromContent(engine, 'notes/simple', content, { noEmbed: true });
    expect(result.status).toBe('imported');

    const page = await engine.getPage('notes/simple');
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('plain markdown');
  });
});

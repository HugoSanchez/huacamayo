import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';

describe('Graph: Links, Backlinks, Traversal', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    // Create a small graph:
    // attention-paper -> transformer-concept
    // attention-paper -> vaswani (person)
    // bert-paper -> transformer-concept
    // transformer-concept -> deep-learning

    for (const [slug, type, title] of [
      ['papers/attention', 'concept', 'Attention Is All You Need'],
      ['papers/bert', 'concept', 'BERT'],
      ['concepts/transformer', 'concept', 'Transformer'],
      ['people/vaswani', 'person', 'Ashish Vaswani'],
      ['concepts/deep-learning', 'concept', 'Deep Learning'],
    ] as const) {
      await engine.putPage(slug, {
        type: type as any,
        title,
        compiled_truth: `Page about ${title}.`,
        timeline: '',
        frontmatter: {},
      });
    }

    await engine.addLink('papers/attention', 'concepts/transformer', 'introduces', 'introduces');
    await engine.addLink('papers/attention', 'people/vaswani', 'authored by', 'authored_by');
    await engine.addLink('papers/bert', 'concepts/transformer', 'builds on', 'builds_on');
    await engine.addLink('concepts/transformer', 'concepts/deep-learning', 'subfield of', 'subfield_of');
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  describe('links', () => {
    it('returns outgoing links from a page', async () => {
      const links = await engine.getLinks('papers/attention');
      expect(links.length).toBe(2);
      const targets = links.map(l => l.to_slug || l.to);
      expect(targets).toContain('concepts/transformer');
      expect(targets).toContain('people/vaswani');
    });

    it('returns empty for pages with no outgoing links', async () => {
      const links = await engine.getLinks('concepts/deep-learning');
      expect(links.length).toBe(0);
    });
  });

  describe('backlinks', () => {
    it('returns incoming links to a page', async () => {
      const backlinks = await engine.getBacklinks('concepts/transformer');
      expect(backlinks.length).toBe(2);
      const sources = backlinks.map(l => l.from_slug || l.from);
      expect(sources).toContain('papers/attention');
      expect(sources).toContain('papers/bert');
    });

    it('returns empty for pages with no incoming links', async () => {
      const backlinks = await engine.getBacklinks('papers/attention');
      expect(backlinks.length).toBe(0);
    });
  });

  describe('removeLink', () => {
    it('removes a specific link', async () => {
      await engine.removeLink('papers/attention', 'people/vaswani');
      const links = await engine.getLinks('papers/attention');
      expect(links.length).toBe(1);
      const targets = links.map(l => l.to_slug || l.to);
      expect(targets).not.toContain('people/vaswani');
    });
  });

  describe('traverseGraph', () => {
    it('traverses from a node at depth 1', async () => {
      const graph = await engine.traverseGraph('papers/attention', 1);
      // Should include attention + its direct neighbors (transformer, vaswani)
      const slugs = graph.map(n => n.slug);
      expect(slugs).toContain('papers/attention');
      expect(slugs).toContain('concepts/transformer');
      expect(slugs).toContain('people/vaswani');
    });

    it('traverses at depth 2 to reach transitive neighbors', async () => {
      const graph = await engine.traverseGraph('papers/attention', 2);
      const slugs = graph.map(n => n.slug);
      // depth 2 should reach deep-learning (attention→transformer→deep-learning)
      expect(slugs).toContain('concepts/deep-learning');
      // bert is NOT reachable — traversal follows outgoing links only,
      // and bert→transformer is an incoming link to transformer
      expect(slugs).not.toContain('papers/bert');
    });

    it('depth 0 returns just the start node', async () => {
      const graph = await engine.traverseGraph('papers/attention', 0);
      expect(graph.length).toBe(1);
      expect(graph[0].slug).toBe('papers/attention');
    });
  });
});

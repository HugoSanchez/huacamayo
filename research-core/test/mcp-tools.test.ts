import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { importFromContent } from '../src/engine/import-file.ts';
import {
  contextSearch,
  contextGet,
  entityLookup,
  graphNeighbors,
  graphTraverse,
  entitySummary,
  ToolError,
} from '../src/mcp/tools.ts';

/**
 * MCP tool handler tests.
 *
 * These test the pure logic layer (no MCP protocol).
 * Search-based tools (contextSearch, entityLookup, entitySummary) are
 * keyword-only since embedding models may not be present in CI.
 */
describe('MCP Tool Handlers', () => {
  let engine: BrainEngine;
  let contextId: string;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    // Create a source and context
    const source = await engine.createSource({
      id: 'src-test',
      name: 'Test Papers',
      location: '/tmp/test-papers',
    });

    const ctx = await engine.createContext({
      id: 'ctx-research',
      name: 'Research',
      source_ids: [source.id],
    });
    contextId = ctx.id;

    // Import some test content
    await importFromContent(engine, 'transformer-architecture', [
      '# Attention Is All You Need',
      '',
      'The Transformer architecture relies entirely on self-attention mechanisms,',
      'dispensing with recurrence and convolutions entirely.',
      'It was introduced by Vaswani et al. in 2017.',
      '',
      'The model uses multi-head attention to jointly attend to information',
      'from different representation subspaces.',
    ].join('\n'), { sourceId: source.id });

    await importFromContent(engine, 'bert-paper', [
      '# BERT: Pre-training of Deep Bidirectional Transformers',
      '',
      'BERT is designed to pre-train deep bidirectional representations',
      'from unlabeled text by jointly conditioning on both left and right context.',
      'It was developed by Devlin et al. at Google.',
    ].join('\n'), { sourceId: source.id });

    await importFromContent(engine, 'gpt-overview', [
      '# GPT: Generative Pre-trained Transformers',
      '',
      'GPT models are autoregressive language models that use the Transformer',
      'decoder architecture. They generate text by predicting the next token.',
      'GPT was developed by OpenAI.',
    ].join('\n'), { sourceId: source.id });

    // Add some links for graph tests
    await engine.addLink('bert-paper', 'transformer-architecture', 'BERT builds on the Transformer', 'extends');
    await engine.addLink('gpt-overview', 'transformer-architecture', 'GPT uses Transformer decoder', 'extends');
    await engine.addLink('bert-paper', 'gpt-overview', 'BERT vs GPT comparison', 'related');

    // Add tags
    await engine.addTag('transformer-architecture', 'foundational');
    await engine.addTag('bert-paper', 'nlp');
    await engine.addTag('gpt-overview', 'nlp');
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  // ── context_search ────────────────────────────────────────────

  describe('context_search', () => {
    it('returns ranked results for a query', async () => {
      const result = await contextSearch(engine, {
        context_id: contextId,
        query: 'attention mechanism',
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('slug');
      expect(result.results[0]).toHaveProperty('title');
      expect(result.results[0]).toHaveProperty('chunk_text');
      expect(result.results[0]).toHaveProperty('score');
      expect(result.results[0]).toHaveProperty('citation');
    });

    it('citation format is slug#chunk_index', async () => {
      const result = await contextSearch(engine, {
        context_id: contextId,
        query: 'transformer',
      });
      expect(result.results.length).toBeGreaterThan(0);
      const citation = result.results[0].citation;
      expect(citation).toMatch(/^.+#\d+$/);
    });

    it('respects limit parameter', async () => {
      const result = await contextSearch(engine, {
        context_id: contextId,
        query: 'transformer',
        limit: 1,
      });
      expect(result.results.length).toBeLessThanOrEqual(1);
    });

    it('throws on nonexistent context', async () => {
      await expect(
        contextSearch(engine, { context_id: 'nonexistent', query: 'test' }),
      ).rejects.toThrow(ToolError);
    });
  });

  // ── context_get ───────────────────────────────────────────────

  describe('context_get', () => {
    it('returns full page content', async () => {
      const result = await contextGet(engine, {
        context_id: contextId,
        slug: 'transformer-architecture',
      });
      expect(result.slug).toBe('transformer-architecture');
      expect(result.title).toBeTruthy();
      expect(result.content).toContain('self-attention');
      expect(result.tags).toContain('foundational');
      expect(result.source_id).toBe('src-test');
    });

    it('throws on nonexistent page', async () => {
      await expect(
        contextGet(engine, { context_id: contextId, slug: 'nonexistent' }),
      ).rejects.toThrow(ToolError);
    });

    it('throws on nonexistent context', async () => {
      await expect(
        contextGet(engine, { context_id: 'bad-ctx', slug: 'transformer-architecture' }),
      ).rejects.toThrow(ToolError);
    });

    it('rejects page not in context', async () => {
      // Create a page with a different source
      const otherSource = await engine.createSource({
        id: 'src-other',
        name: 'Other',
        location: '/tmp/other',
      });
      await importFromContent(engine, 'secret-doc', 'Secret content', {
        sourceId: otherSource.id,
      });

      await expect(
        contextGet(engine, { context_id: contextId, slug: 'secret-doc' }),
      ).rejects.toThrow(/not in context/);
    });
  });

  // ── entity_lookup ─────────────────────────────────────────────

  describe('entity_lookup', () => {
    it('finds entity by exact slug', async () => {
      const result = await entityLookup(engine, {
        context_id: contextId,
        name_or_slug: 'bert-paper',
      });
      expect(result.found).toBe(true);
      expect(result.page).not.toBeNull();
      expect(result.page!.slug).toBe('bert-paper');
      expect(result.page!.tags).toContain('nlp');
    });

    it('returns evidence chunks', async () => {
      const result = await entityLookup(engine, {
        context_id: contextId,
        name_or_slug: 'bert-paper',
      });
      expect(result.evidence).toBeDefined();
      expect(Array.isArray(result.evidence)).toBe(true);
    });

    it('returns found=false for unknown entity with search evidence', async () => {
      const result = await entityLookup(engine, {
        context_id: contextId,
        name_or_slug: 'unknown-entity-xyz',
      });
      expect(result.found).toBe(false);
      expect(result.page).toBeNull();
    });

    it('throws on nonexistent context', async () => {
      await expect(
        entityLookup(engine, { context_id: 'bad-ctx', name_or_slug: 'bert' }),
      ).rejects.toThrow(ToolError);
    });
  });

  // ── graph_neighbors ───────────────────────────────────────────

  describe('graph_neighbors', () => {
    it('returns both outgoing and incoming neighbors by default', async () => {
      const result = await graphNeighbors(engine, {
        context_id: contextId,
        slug: 'transformer-architecture',
      });
      expect(result.slug).toBe('transformer-architecture');
      // transformer-architecture has incoming links from bert-paper and gpt-overview
      expect(result.neighbors.length).toBeGreaterThanOrEqual(2);
      const incoming = result.neighbors.filter((n) => n.direction === 'incoming');
      expect(incoming.length).toBeGreaterThanOrEqual(2);
    });

    it('filters by direction', async () => {
      const outgoing = await graphNeighbors(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        direction: 'outgoing',
      });
      // bert-paper links to transformer-architecture and gpt-overview
      expect(outgoing.neighbors.length).toBe(2);
      expect(outgoing.neighbors.every((n) => n.direction === 'outgoing')).toBe(true);

      const incoming = await graphNeighbors(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        direction: 'incoming',
      });
      expect(incoming.neighbors.every((n) => n.direction === 'incoming')).toBe(true);
    });

    it('filters by edge type', async () => {
      const result = await graphNeighbors(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        edge_types: ['extends'],
      });
      expect(result.neighbors.every((n) => n.link_type === 'extends')).toBe(true);
    });

    it('respects limit', async () => {
      const result = await graphNeighbors(engine, {
        context_id: contextId,
        slug: 'transformer-architecture',
        limit: 1,
      });
      expect(result.neighbors.length).toBeLessThanOrEqual(1);
    });

    it('throws on nonexistent page', async () => {
      await expect(
        graphNeighbors(engine, { context_id: contextId, slug: 'nonexistent' }),
      ).rejects.toThrow(ToolError);
    });
  });

  // ── graph_traverse ────────────────────────────────────────────

  describe('graph_traverse', () => {
    it('returns subgraph from starting node', async () => {
      const result = await graphTraverse(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        depth: 2,
      });
      expect(result.root).toBe('bert-paper');
      expect(result.nodes.length).toBeGreaterThan(0);
      // Should find bert-paper itself and its neighbors
      const slugs = result.nodes.map((n) => n.slug);
      expect(slugs).toContain('bert-paper');
    });

    it('caps depth at 3', async () => {
      const result = await graphTraverse(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        depth: 10, // should be capped to 3
      });
      const maxDepth = Math.max(...result.nodes.map((n) => n.depth));
      expect(maxDepth).toBeLessThanOrEqual(3);
    });

    it('filters by edge type', async () => {
      const result = await graphTraverse(engine, {
        context_id: contextId,
        slug: 'bert-paper',
        edge_types: ['extends'],
      });
      // All remaining links should be 'extends' type
      for (const node of result.nodes) {
        for (const link of node.links) {
          expect(link.link_type).toBe('extends');
        }
      }
    });

    it('throws on nonexistent context', async () => {
      await expect(
        graphTraverse(engine, { context_id: 'bad-ctx', slug: 'bert-paper' }),
      ).rejects.toThrow(ToolError);
    });
  });

  // ── entity_summary ────────────────────────────────────────────

  describe('entity_summary', () => {
    it('returns summary with all fields', async () => {
      const result = await entitySummary(engine, {
        context_id: contextId,
        slug: 'bert-paper',
      });
      expect(result.slug).toBe('bert-paper');
      expect(result.title).toBeTruthy();
      expect(result.type).toBeTruthy();
      expect(result.summary).toBeTruthy();
      expect(result.tags).toContain('nlp');
      expect(result.neighbor_count).toBeGreaterThanOrEqual(2); // 2 outgoing links
    });

    it('returns evidence from other pages', async () => {
      const result = await entitySummary(engine, {
        context_id: contextId,
        slug: 'transformer-architecture',
      });
      // Evidence should not include the page itself (excluded via exclude_slugs)
      const evidenceSlugs = result.evidence.map((e) => e.slug);
      expect(evidenceSlugs).not.toContain('transformer-architecture');
    });

    it('throws on nonexistent page', async () => {
      await expect(
        entitySummary(engine, { context_id: contextId, slug: 'nonexistent' }),
      ).rejects.toThrow(ToolError);
    });

    it('throws on nonexistent context', async () => {
      await expect(
        entitySummary(engine, { context_id: 'bad-ctx', slug: 'bert-paper' }),
      ).rejects.toThrow(ToolError);
    });
  });
});

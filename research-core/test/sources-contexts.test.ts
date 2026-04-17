import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';
import { importFromContent } from '../src/engine/import-file.ts';

describe('Sources and Contexts', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  describe('Source CRUD', () => {
    it('creates a source', async () => {
      const source = await engine.createSource({
        id: 'src-papers',
        name: 'ML Papers',
        location: '/Users/test/papers',
      });
      expect(source.id).toBe('src-papers');
      expect(source.name).toBe('ML Papers');
      expect(source.location).toBe('/Users/test/papers');
      expect(source.type).toBe('folder');
      expect(source.status).toBe('active');
    });

    it('generates id if not provided', async () => {
      const source = await engine.createSource({ location: '/tmp/test' });
      expect(source.id).toBeTruthy();
      expect(source.id.length).toBeGreaterThan(0);
    });

    it('gets a source by id', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      const source = await engine.getSource('src-1');
      expect(source).not.toBeNull();
      expect(source!.id).toBe('src-1');
    });

    it('returns null for nonexistent source', async () => {
      const source = await engine.getSource('nonexistent');
      expect(source).toBeNull();
    });

    it('lists all sources', async () => {
      await engine.createSource({ id: 'src-a', location: '/tmp/a' });
      await engine.createSource({ id: 'src-b', location: '/tmp/b' });
      const sources = await engine.listSources();
      expect(sources.length).toBe(2);
    });

    it('updates source status', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      await engine.updateSourceStatus('src-1', 'indexing');
      const source = await engine.getSource('src-1');
      expect(source!.status).toBe('indexing');
    });

    it('deletes a source and its pages', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      await engine.putPage('src1/doc', {
        type: 'reference', title: 'Doc', compiled_truth: 'Content', source_id: 'src-1',
      });
      await engine.deleteSource('src-1');
      const source = await engine.getSource('src-1');
      expect(source).toBeNull();
      const page = await engine.getPage('src1/doc');
      expect(page).toBeNull();
    });
  });

  describe('Context CRUD', () => {
    it('creates a context with sources', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      await engine.createSource({ id: 'src-2', location: '/tmp/b' });

      const ctx = await engine.createContext({
        id: 'ctx-ml',
        name: 'ML Research',
        source_ids: ['src-1', 'src-2'],
      });

      expect(ctx.id).toBe('ctx-ml');
      expect(ctx.name).toBe('ML Research');
      expect(ctx.source_ids).toContain('src-1');
      expect(ctx.source_ids).toContain('src-2');
    });

    it('creates a context without sources', async () => {
      const ctx = await engine.createContext({ id: 'ctx-empty', name: 'Empty' });
      expect(ctx.source_ids.length).toBe(0);
    });

    it('gets a context with its source_ids', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      await engine.createContext({ id: 'ctx-1', name: 'Test', source_ids: ['src-1'] });

      const ctx = await engine.getContext('ctx-1');
      expect(ctx).not.toBeNull();
      expect(ctx!.source_ids).toContain('src-1');
    });

    it('lists all contexts', async () => {
      await engine.createContext({ id: 'ctx-a', name: 'A' });
      await engine.createContext({ id: 'ctx-b', name: 'B' });
      const contexts = await engine.listContexts();
      expect(contexts.length).toBe(2);
    });

    it('adds and removes sources from a context', async () => {
      await engine.createSource({ id: 'src-1', location: '/tmp/a' });
      await engine.createSource({ id: 'src-2', location: '/tmp/b' });
      await engine.createContext({ id: 'ctx-1', name: 'Test', source_ids: ['src-1'] });

      await engine.addSourceToContext('ctx-1', 'src-2');
      let ctx = await engine.getContext('ctx-1');
      expect(ctx!.source_ids).toContain('src-2');

      await engine.removeSourceFromContext('ctx-1', 'src-1');
      ctx = await engine.getContext('ctx-1');
      expect(ctx!.source_ids).not.toContain('src-1');
      expect(ctx!.source_ids).toContain('src-2');
    });

    it('deletes a context', async () => {
      await engine.createContext({ id: 'ctx-1', name: 'Test' });
      await engine.deleteContext('ctx-1');
      const ctx = await engine.getContext('ctx-1');
      expect(ctx).toBeNull();
    });
  });

  describe('Import with source_id', () => {
    it('sets source_id on imported page', async () => {
      await engine.createSource({ id: 'src-papers', location: '/tmp/papers' });

      await importFromContent(engine, 'papers/attention', `---
title: Attention Paper
---
Content here.
`, { noEmbed: true, sourceId: 'src-papers' });

      const page = await engine.getPage('papers/attention');
      expect(page).not.toBeNull();
      expect(page!.source_id).toBe('src-papers');
    });

    it('page without source_id has null source_id', async () => {
      await importFromContent(engine, 'notes/orphan', `---
title: Orphan Note
---
No source.
`, { noEmbed: true });

      const page = await engine.getPage('notes/orphan');
      expect(page!.source_id).toBeNull();
    });
  });

  describe('Context-scoped search', () => {
    beforeEach(async () => {
      // Create two sources
      await engine.createSource({ id: 'src-papers', location: '/tmp/papers' });
      await engine.createSource({ id: 'src-recipes', location: '/tmp/recipes' });

      // Import pages with source provenance
      await importFromContent(engine, 'papers/attention', `---
title: Attention Is All You Need
type: concept
---
The transformer architecture relies on self-attention mechanisms.
`, { noEmbed: true, sourceId: 'src-papers' });

      await engine.upsertChunks('papers/attention', [{
        chunk_index: 0,
        chunk_text: 'The transformer architecture relies on self-attention mechanisms.',
        chunk_source: 'compiled_truth',
      }]);

      await importFromContent(engine, 'recipes/pasta', `---
title: Pasta Recipe
type: concept
---
Boil water, add pasta, cook for 8 minutes.
`, { noEmbed: true, sourceId: 'src-recipes' });

      await engine.upsertChunks('recipes/pasta', [{
        chunk_index: 0,
        chunk_text: 'Boil water, add pasta, cook for 8 minutes.',
        chunk_source: 'compiled_truth',
      }]);

      // Create contexts
      await engine.createContext({ id: 'ctx-ml', name: 'ML Research', source_ids: ['src-papers'] });
      await engine.createContext({ id: 'ctx-cooking', name: 'Cooking', source_ids: ['src-recipes'] });
      await engine.createContext({ id: 'ctx-all', name: 'Everything', source_ids: ['src-papers', 'src-recipes'] });
    });

    it('scoped search returns only pages from context sources', async () => {
      const mlResults = await engine.searchKeyword('transformer', { contextId: 'ctx-ml' });
      const slugs = mlResults.map(r => r.slug);
      expect(slugs).toContain('papers/attention');
    });

    it('scoped search excludes pages from other sources', async () => {
      // Search for something that exists in recipes but scope to ML context
      const mlResults = await engine.searchKeyword('pasta', { contextId: 'ctx-ml' });
      expect(mlResults.length).toBe(0);
    });

    it('scoped search with shared source returns results from both', async () => {
      const allResults = await engine.searchKeyword('transformer OR pasta', { contextId: 'ctx-all' });
      const slugs = allResults.map(r => r.slug);
      expect(slugs.length).toBeGreaterThan(0);
    });

    it('unscoped search returns everything', async () => {
      const allResults = await engine.searchKeyword('transformer OR pasta');
      const slugs = allResults.map(r => r.slug);
      expect(slugs).toContain('papers/attention');
      expect(slugs).toContain('recipes/pasta');
    });

    it('two contexts sharing a source both see the same pages', async () => {
      // Add papers source to cooking context too
      await engine.addSourceToContext('ctx-cooking', 'src-papers');

      const cookingResults = await engine.searchKeyword('transformer', { contextId: 'ctx-cooking' });
      const mlResults = await engine.searchKeyword('transformer', { contextId: 'ctx-ml' });

      expect(cookingResults.length).toBeGreaterThan(0);
      expect(mlResults.length).toBeGreaterThan(0);
      expect(cookingResults[0].slug).toBe(mlResults[0].slug);
    });
  });
});

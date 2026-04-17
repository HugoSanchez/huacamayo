import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGLiteEngine } from '../src/engine/pglite-engine.ts';
import type { BrainEngine } from '../src/engine/engine.ts';

describe('Engine CRUD', () => {
  let engine: BrainEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  describe('putPage + getPage', () => {
    it('creates a page and reads it back', async () => {
      const page = await engine.putPage('test/my-page', {
        type: 'concept',
        title: 'My Page',
        compiled_truth: 'Some content here.',
        timeline: '',
        frontmatter: { source: 'test' },
      });

      expect(page.slug).toBe('test/my-page');
      expect(page.title).toBe('My Page');
      expect(page.type).toBe('concept');

      const fetched = await engine.getPage('test/my-page');
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('My Page');
      expect(fetched!.compiled_truth).toBe('Some content here.');
      expect(fetched!.frontmatter).toEqual({ source: 'test' });
    });

    it('updates an existing page', async () => {
      await engine.putPage('test/update-me', {
        type: 'concept',
        title: 'Version 1',
        compiled_truth: 'Original content.',
        timeline: '',
        frontmatter: {},
      });

      await engine.putPage('test/update-me', {
        type: 'concept',
        title: 'Version 2',
        compiled_truth: 'Updated content.',
        timeline: 'Timeline added.',
        frontmatter: {},
      });

      const fetched = await engine.getPage('test/update-me');
      expect(fetched!.title).toBe('Version 2');
      expect(fetched!.compiled_truth).toBe('Updated content.');
      expect(fetched!.timeline).toBe('Timeline added.');
    });

    it('returns null for non-existent page', async () => {
      const page = await engine.getPage('does/not-exist');
      expect(page).toBeNull();
    });
  });

  describe('deletePage', () => {
    it('deletes a page', async () => {
      await engine.putPage('test/delete-me', {
        type: 'concept',
        title: 'Delete Me',
        compiled_truth: 'Going away.',
        timeline: '',
        frontmatter: {},
      });

      await engine.deletePage('test/delete-me');
      const fetched = await engine.getPage('test/delete-me');
      expect(fetched).toBeNull();
    });
  });

  describe('listPages', () => {
    it('lists all pages', async () => {
      await engine.putPage('people/alice', {
        type: 'person',
        title: 'Alice',
        compiled_truth: 'Alice is a researcher.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('concepts/ml', {
        type: 'concept',
        title: 'Machine Learning',
        compiled_truth: 'ML is a field of AI.',
        timeline: '',
        frontmatter: {},
      });

      const all = await engine.listPages();
      expect(all.length).toBe(2);
    });

    it('filters by type', async () => {
      await engine.putPage('people/bob', {
        type: 'person',
        title: 'Bob',
        compiled_truth: 'Bob is an engineer.',
        timeline: '',
        frontmatter: {},
      });
      await engine.putPage('concepts/ai', {
        type: 'concept',
        title: 'AI',
        compiled_truth: 'Artificial intelligence.',
        timeline: '',
        frontmatter: {},
      });

      const people = await engine.listPages({ type: 'person' as any });
      expect(people.length).toBe(1);
      expect(people[0].slug).toBe('people/bob');
    });
  });

  describe('slug validation', () => {
    it('lowercases slugs', async () => {
      const page = await engine.putPage('Test/UPPER-Case', {
        type: 'concept',
        title: 'Test',
        compiled_truth: 'Content.',
        timeline: '',
        frontmatter: {},
      });
      expect(page.slug).toBe('test/upper-case');
    });

    it('rejects empty slugs', async () => {
      await expect(engine.putPage('', {
        type: 'concept',
        title: 'Bad',
        compiled_truth: '',
        timeline: '',
        frontmatter: {},
      })).rejects.toThrow();
    });

    it('rejects path traversal', async () => {
      await expect(engine.putPage('../escape', {
        type: 'concept',
        title: 'Bad',
        compiled_truth: '',
        timeline: '',
        frontmatter: {},
      })).rejects.toThrow();
    });
  });
});

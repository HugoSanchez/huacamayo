import { describe, it, expect } from 'vitest';
import { slugifyPath, slugifySegment, validateSlug } from '../src/engine/utils.ts';

describe('Slug utilities', () => {
  describe('slugifySegment', () => {
    it('lowercases', () => {
      expect(slugifySegment('Hello')).toBe('hello');
    });

    it('replaces spaces with hyphens', () => {
      expect(slugifySegment('hello world')).toBe('hello-world');
    });

    it('strips accents', () => {
      expect(slugifySegment('café')).toBe('cafe');
    });

    it('preserves dots', () => {
      expect(slugifySegment('v1.0.0')).toBe('v1.0.0');
    });

    it('collapses multiple hyphens', () => {
      expect(slugifySegment('a--b---c')).toBe('a-b-c');
    });

    it('strips special characters', () => {
      expect(slugifySegment('hello@world!')).toBe('helloworld');
    });
  });

  describe('slugifyPath', () => {
    it('strips .md extension', () => {
      expect(slugifyPath('notes/my-note.md')).toBe('notes/my-note');
    });

    it('strips .mdx extension', () => {
      expect(slugifyPath('docs/guide.mdx')).toBe('docs/guide');
    });

    it('normalizes path separators', () => {
      expect(slugifyPath('notes\\windows\\path.md')).toBe('notes/windows/path');
    });

    it('strips leading ./', () => {
      expect(slugifyPath('./notes/hello.md')).toBe('notes/hello');
    });

    it('strips leading /', () => {
      expect(slugifyPath('/notes/hello.md')).toBe('notes/hello');
    });

    it('slugifies each segment independently', () => {
      expect(slugifyPath('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
    });

    it('handles deeply nested paths', () => {
      expect(slugifyPath('a/b/c/d/e.md')).toBe('a/b/c/d/e');
    });
  });

  describe('validateSlug', () => {
    it('lowercases the slug', () => {
      expect(validateSlug('Hello/World')).toBe('hello/world');
    });

    it('rejects empty slug', () => {
      expect(() => validateSlug('')).toThrow();
    });

    it('rejects path traversal', () => {
      expect(() => validateSlug('../escape')).toThrow();
      expect(() => validateSlug('a/../../b')).toThrow();
    });

    it('rejects leading slash', () => {
      expect(() => validateSlug('/absolute')).toThrow();
    });

    it('accepts valid slugs', () => {
      expect(validateSlug('notes/my-note')).toBe('notes/my-note');
      expect(validateSlug('people/alice-smith')).toBe('people/alice-smith');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './session-format';

describe('session time formatting', () => {
  const now = Date.parse('2026-08-18T12:00:00Z');

  it('uses stable compact units for recent sessions', () => {
    expect(formatRelativeTime('2026-08-18T11:59:30Z', now)).toBe('now');
    expect(formatRelativeTime('2026-08-18T11:55:00Z', now)).toBe('5m');
    expect(formatRelativeTime('2026-08-18T09:00:00Z', now)).toBe('3h');
    expect(formatRelativeTime('2026-08-16T12:00:00Z', now)).toBe('2d');
  });

  it('returns an empty label for invalid timestamps', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
  });
});

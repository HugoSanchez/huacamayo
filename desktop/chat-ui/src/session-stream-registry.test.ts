import { describe, expect, it, vi } from 'vitest';
import { SessionStreamRegistry } from './session-stream-registry';

describe('SessionStreamRegistry', () => {
  it('tracks and cancels concurrent sessions independently', () => {
    const registry = new SessionStreamRegistry();
    const abortA = vi.fn();
    const abortB = vi.fn();

    registry.start('a', abortA);
    registry.start('b', abortB);
    expect(registry.isStreaming('a')).toBe(true);
    expect(registry.isStreaming('b')).toBe(true);

    expect(registry.abort('a')).toBe(true);
    expect(abortA).toHaveBeenCalledOnce();
    expect(abortB).not.toHaveBeenCalled();

    const completion = registry.finish('a', 'a');
    expect(completion.activeSessionIds).toEqual(new Set(['b']));
    expect(completion.becameUnread).toBe(false);
  });

  it('marks a background completion unread exactly once', () => {
    const registry = new SessionStreamRegistry();
    registry.start('background', () => {});

    expect(registry.finish('background', 'foreground').becameUnread).toBe(true);
    expect(registry.markViewed('background')).toBe(true);
    expect(registry.finish('background', 'foreground').becameUnread).toBe(false);
    expect(registry.markViewed('background')).toBe(false);
  });
});

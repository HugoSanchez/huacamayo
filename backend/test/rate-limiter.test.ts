import { describe, expect, test } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/inference/rate-limiter.ts';

describe('SlidingWindowRateLimiter', () => {
  test('allows requests up to the cap within the window', () => {
    const rl = new SlidingWindowRateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(rl.check('u1', now).allowed).toBe(true);
    expect(rl.check('u1', now + 100).allowed).toBe(true);
    expect(rl.check('u1', now + 200).allowed).toBe(true);
    const blocked = rl.check('u1', now + 300);
    expect(blocked.allowed).toBe(false);
    // First request at `now` expires at now+60_000; remaining ≈ 59_700ms.
    expect(blocked.retryAfterMs).toBeGreaterThan(59_000);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  test('allows the next request once the oldest timestamp falls out of the window', () => {
    const rl = new SlidingWindowRateLimiter(2, 60_000);
    rl.check('u1', 0);
    rl.check('u1', 100);
    expect(rl.check('u1', 200).allowed).toBe(false);
    // 60_001 ms after the first call, the window slides past it.
    expect(rl.check('u1', 60_001).allowed).toBe(true);
  });

  test('tracks buckets per user independently', () => {
    const rl = new SlidingWindowRateLimiter(1, 60_000);
    expect(rl.check('alice', 0).allowed).toBe(true);
    expect(rl.check('alice', 100).allowed).toBe(false);
    // Bob is untouched.
    expect(rl.check('bob', 100).allowed).toBe(true);
  });
});

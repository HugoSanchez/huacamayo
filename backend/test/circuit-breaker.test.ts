import { describe, expect, test } from 'vitest';
import { FailureCircuitBreaker } from '../src/inference/circuit-breaker.ts';

describe('FailureCircuitBreaker', () => {
  test('opens after N consecutive failures and blocks until cooldown elapses', () => {
    const cb = new FailureCircuitBreaker(3, 60_000);
    const t0 = 1_000_000;

    // Under threshold — still allowed.
    cb.recordFailure('u1', t0);
    cb.recordFailure('u1', t0 + 10);
    expect(cb.check('u1', t0 + 20).allowed).toBe(true);

    // Third failure trips the breaker.
    cb.recordFailure('u1', t0 + 30);
    const blocked = cb.check('u1', t0 + 40);
    expect(blocked.allowed).toBe(false);
    expect(blocked.cooldownRemainingMs).toBeGreaterThan(59_000);

    // Still blocked just before cooldown ends.
    expect(cb.check('u1', t0 + 30 + 59_999).allowed).toBe(false);

    // Allowed at the cooldown boundary.
    expect(cb.check('u1', t0 + 30 + 60_000).allowed).toBe(true);
  });

  test('a successful call resets the counter so failures must restart from zero', () => {
    const cb = new FailureCircuitBreaker(3, 60_000);
    cb.recordFailure('u1');
    cb.recordFailure('u1');
    cb.recordSuccess('u1');
    cb.recordFailure('u1'); // counter restarted, no open
    cb.recordFailure('u1');
    expect(cb.check('u1').allowed).toBe(true);
  });

  test('tracks state per user independently', () => {
    const cb = new FailureCircuitBreaker(2, 60_000);
    cb.recordFailure('alice');
    cb.recordFailure('alice');
    expect(cb.check('alice').allowed).toBe(false);
    expect(cb.check('bob').allowed).toBe(true);
  });
});

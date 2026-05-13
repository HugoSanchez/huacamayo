/**
 * Per-user consecutive-failure breaker. After `threshold` failures in a row,
 * the user is auto-paused for `cooldownMs`. Any successful inference resets
 * the counter. This is the simplest anomaly defence we ship: it stops a
 * runaway agent loop (Hermes retrying a tool that keeps failing, or an OpenRouter
 * outage) from burning auth + spend-limit + DB cycles indefinitely.
 *
 * State is per-process. On backend restart the breaker reopens for everyone —
 * acceptable trade-off: real users get a clean slate, abusers re-trip within
 * seconds.
 */
export interface BreakerDecision {
  allowed: boolean;
  /** When `allowed=false`, milliseconds remaining before auto-recovery. */
  cooldownRemainingMs: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export class FailureCircuitBreaker {
  private readonly states = new Map<string, BreakerState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  check(userId: string, now: number = Date.now()): BreakerDecision {
    const state = this.states.get(userId);
    if (!state || state.openedAt === null) {
      return {
        allowed: true,
        cooldownRemainingMs: 0,
        lastErrorCode: state?.lastErrorCode ?? null,
        lastErrorMessage: state?.lastErrorMessage ?? null,
      };
    }
    const elapsed = now - state.openedAt;
    if (elapsed >= this.cooldownMs) {
      // Cooldown elapsed; clear breaker but keep counter at threshold so a
      // single further failure re-opens us — we don't trust a half-recovered
      // user to immediately go on a fresh streak.
      state.openedAt = null;
      return {
        allowed: true,
        cooldownRemainingMs: 0,
        lastErrorCode: state.lastErrorCode,
        lastErrorMessage: state.lastErrorMessage,
      };
    }
    return {
      allowed: false,
      cooldownRemainingMs: this.cooldownMs - elapsed,
      lastErrorCode: state.lastErrorCode,
      lastErrorMessage: state.lastErrorMessage,
    };
  }

  recordSuccess(userId: string): void {
    const state = this.states.get(userId);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.openedAt = null;
  }

  recordFailure(
    userId: string,
    now: number = Date.now(),
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): void {
    const state = this.states.get(userId) ?? {
      consecutiveFailures: 0,
      openedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    state.consecutiveFailures += 1;
    state.lastErrorCode = errorCode;
    state.lastErrorMessage = errorMessage;
    if (state.consecutiveFailures >= this.threshold) {
      state.openedAt = now;
    }
    this.states.set(userId, state);
  }
}

/**
 * Sliding-window rate limiter, in-process. Each user has a bucket of recent
 * timestamps; requests within the window count toward the cap. Old timestamps
 * are dropped lazily on each check. State is per-process — resets on restart,
 * which is acceptable for V1: this is defense against bug-loops and abuse
 * within a single backend lifetime, not a billing-grade meter.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** When `allowed=false`, milliseconds until the user can retry the request. */
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(maxPerWindow: number, windowMs = 60_000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }

  check(userId: string, now: number = Date.now()): RateLimitDecision {
    const cutoff = now - this.windowMs;
    const bucket = this.pruneBucket(userId, cutoff);
    if (bucket.length >= this.maxPerWindow) {
      // Oldest entry will fall out of the window at `bucket[0] + windowMs`.
      const retryAfterMs = bucket[0] + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }
    bucket.push(now);
    this.buckets.set(userId, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }

  private pruneBucket(userId: string, cutoff: number): number[] {
    const existing = this.buckets.get(userId) ?? [];
    // Linear sweep is fine — typical bucket sizes are small (<= cap).
    let dropFromStart = 0;
    while (dropFromStart < existing.length && existing[dropFromStart] < cutoff) {
      dropFromStart += 1;
    }
    return dropFromStart === 0 ? existing : existing.slice(dropFromStart);
  }
}

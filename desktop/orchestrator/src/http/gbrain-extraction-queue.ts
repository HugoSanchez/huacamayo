// Serializes GBrain extraction runs across producers (chat extraction and
// source ingestion). GBrainMemoryRuntime only serializes the JSON-RPC layer;
// it does NOT stop two logical extraction runs — each doing search→read→write
// across many tool calls — from interleaving and double-writing the same page.
// This queue makes whole runs mutually exclusive.
//
// It is also priority-aware: a long source-ingestion drain must not starve
// latency-sensitive chat extraction. When the lock frees and both are waiting,
// the chat waiter goes first (FIFO within a priority). Non-preemptive: an
// in-flight run always finishes before the next waiter is handed the lock.

export type ExtractionPriority = 'chat' | 'source';

interface Waiter {
  priority: ExtractionPriority;
  resolve: () => void;
}

export class GBrainExtractionQueue {
  private running = false;
  private readonly waiters: Waiter[] = [];

  /** Run `task` under the lock at the given priority, releasing even if it throws. */
  async run<T>(priority: ExtractionPriority, task: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  private acquire(priority: ExtractionPriority): Promise<void> {
    if (!this.running) {
      this.running = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.enqueue({ priority, resolve });
    });
  }

  private enqueue(waiter: Waiter): void {
    if (waiter.priority === 'chat') {
      // Ahead of all source waiters, behind any earlier chat waiters (FIFO).
      const firstSource = this.waiters.findIndex((w) => w.priority === 'source');
      if (firstSource === -1) this.waiters.push(waiter);
      else this.waiters.splice(firstSource, 0, waiter);
    } else {
      this.waiters.push(waiter);
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the lock straight to the next waiter — `running` stays true.
      next.resolve();
    } else {
      this.running = false;
    }
  }
}

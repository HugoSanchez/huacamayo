export interface SessionStreamCompletion {
  activeSessionIds: Set<string>;
  becameUnread: boolean;
}

export class SessionStreamRegistry {
  private readonly controllers = new Map<string, () => void>();
  private readonly unreadSessionIds = new Set<string>();

  start(sessionId: string, abort: () => void): Set<string> {
    this.controllers.set(sessionId, abort);
    return this.activeSessionIds();
  }

  finish(sessionId: string, activelyViewedSessionId: string | null): SessionStreamCompletion {
    const wasStreaming = this.controllers.delete(sessionId);
    const becameUnread = wasStreaming
      && activelyViewedSessionId !== sessionId
      && !this.unreadSessionIds.has(sessionId);
    if (becameUnread) this.unreadSessionIds.add(sessionId);
    return { activeSessionIds: this.activeSessionIds(), becameUnread };
  }

  markViewed(sessionId: string): boolean {
    return this.unreadSessionIds.delete(sessionId);
  }

  abort(sessionId: string): boolean {
    const abort = this.controllers.get(sessionId);
    if (!abort) return false;
    abort();
    return true;
  }

  isStreaming(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  private activeSessionIds(): Set<string> {
    return new Set(this.controllers.keys());
  }
}

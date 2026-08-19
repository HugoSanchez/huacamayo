import type { ChatMessage, StoredChatMessage } from './types';

// Messages written before the first session has been created live here. The
// bucket is migrated atomically when the server returns the real session id.
export const PENDING_SESSION_KEY = '__pending__';

export type SessionMessageBuckets = Record<string, ChatMessage[]>;

export function sessionMessageKey(sessionId: string | null): string {
  return sessionId ?? PENDING_SESSION_KEY;
}

export function ensureSessionMessageBucket(
  buckets: SessionMessageBuckets,
  sessionId: string,
): SessionMessageBuckets {
  return sessionId in buckets ? buckets : { ...buckets, [sessionId]: [] };
}

export function updateSessionMessageBucket(
  buckets: SessionMessageBuckets,
  key: string,
  updater: (messages: ChatMessage[]) => ChatMessage[],
): SessionMessageBuckets {
  return { ...buckets, [key]: updater(buckets[key] ?? []) };
}

export function replaceSessionMessageBucket(
  buckets: SessionMessageBuckets,
  sessionId: string,
  messages: ChatMessage[],
): SessionMessageBuckets {
  return { ...buckets, [sessionId]: messages };
}

export function adoptSessionMessageBucket(
  buckets: SessionMessageBuckets,
  previousSessionId: string | null,
  nextSessionId: string,
  preserveMessages: boolean,
): SessionMessageBuckets {
  const previousKey = sessionMessageKey(previousSessionId);
  if (preserveMessages && previousKey !== nextSessionId) {
    const next = { ...buckets };
    const moved = buckets[previousKey] ?? [];
    delete next[previousKey];
    next[nextSessionId] = moved;
    return next;
  }
  if (!preserveMessages) {
    const next = { ...buckets };
    delete next[PENDING_SESSION_KEY];
    next[nextSessionId] = [];
    return next;
  }
  return buckets;
}

export function clearPendingSessionMessageBucket(
  buckets: SessionMessageBuckets,
): SessionMessageBuckets {
  if (!(PENDING_SESSION_KEY in buckets)) return buckets;
  const next = { ...buckets };
  delete next[PENDING_SESSION_KEY];
  return next;
}

export function toUiMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    steps: message.steps,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
  };
}

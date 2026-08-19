import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types';
import {
  PENDING_SESSION_KEY,
  adoptSessionMessageBucket,
  ensureSessionMessageBucket,
  replaceSessionMessageBucket,
  updateSessionMessageBucket,
} from './session-message-model';

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return { id, role, content: id };
}

describe('session message buckets', () => {
  it('moves the complete optimistic exchange into the newly-created session', () => {
    const pending = {
      [PENDING_SESSION_KEY]: [message('user-1', 'user'), message('assistant-1', 'assistant')],
    };

    const adopted = adoptSessionMessageBucket(pending, null, 'session-1', true);

    expect(adopted[PENDING_SESSION_KEY]).toBeUndefined();
    expect(adopted['session-1']?.map((entry) => entry.id)).toEqual(['user-1', 'assistant-1']);
  });

  it('keeps concurrent session updates isolated', () => {
    const initial = {
      a: [message('user-a', 'user')],
      b: [message('user-b', 'user')],
    };

    const streamed = updateSessionMessageBucket(initial, 'a', (messages) => [
      ...messages,
      message('assistant-a', 'assistant'),
    ]);
    const hydrated = replaceSessionMessageBucket(streamed, 'b', [message('stored-b', 'assistant')]);

    expect(hydrated.a.map((entry) => entry.id)).toEqual(['user-a', 'assistant-a']);
    expect(hydrated.b.map((entry) => entry.id)).toEqual(['stored-b']);
  });

  it('seeds an empty bucket without replacing existing messages', () => {
    const initial = { a: [message('user-a', 'user')] };

    expect(ensureSessionMessageBucket(initial, 'a')).toBe(initial);
    expect(ensureSessionMessageBucket(initial, 'b')).toEqual({ ...initial, b: [] });
  });

  it('starts an explicitly new session cleanly', () => {
    const initial = {
      [PENDING_SESSION_KEY]: [message('stale-pending', 'user')],
      existing: [message('existing', 'user')],
    };

    const adopted = adoptSessionMessageBucket(initial, 'existing', 'new-session', false);

    expect(adopted[PENDING_SESSION_KEY]).toBeUndefined();
    expect(adopted.existing).toEqual(initial.existing);
    expect(adopted['new-session']).toEqual([]);
  });
});

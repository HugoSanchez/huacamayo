import { describe, expect, it } from 'vitest';
import { mapHermesRowsToChatMessages } from '../src/http/hermes-history.ts';
import type { ChatMessageRecord } from '../src/http/chat-store.ts';

describe('Hermes history mapper', () => {
  it('hydrates assistant tool activity from Hermes message rows', () => {
    const localMessages: ChatMessageRecord[] = [
      {
        id: 'local-user-1',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Please update the document',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'local-assistant-1',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Done.',
        createdAt: '2026-06-01T10:00:05.000Z',
      },
    ];

    const messages = mapHermesRowsToChatMessages([
      {
        id: 1,
        session_id: 'hermes-session',
        role: 'user',
        content: '[SYSTEM wrapper]\n\nPlease update the document',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962400,
      },
      {
        id: 2,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          id: 'fc_1',
          call_id: 'call_1',
          type: 'function',
          function: {
            name: 'google_drive',
            arguments: JSON.stringify({ action: 'search', query: 'contract' }),
          },
        }]),
        tool_name: null,
        timestamp: 1779962401,
      },
      {
        id: 3,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ ok: true }),
        tool_call_id: 'call_1',
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962402,
      },
      {
        id: 4,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Done.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962403,
      },
    ], {
      hermesSessionId: 'hermes-session',
      versoSessionId: 'verso-session',
      localMessages,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 'local-user-1',
      role: 'user',
      content: 'Please update the document',
    });
    expect(messages[1]).toMatchObject({
      id: 'local-assistant-1',
      role: 'assistant',
      content: 'Done.',
      startedAt: Date.parse('2026-06-01T10:00:00.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:05.000Z'),
    });
    expect(messages[1].steps).toEqual([{
      type: 'tool',
      id: 'call_1',
      name: 'google_drive',
      input: { action: 'search', query: 'contract' },
      result: JSON.stringify({ ok: true }),
    }]);
  });

  it('uses local messages as the visible turn skeleton when Hermes omits a user row', () => {
    const localMessages: ChatMessageRecord[] = [
      {
        id: 'local-user-1',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Create a draft',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: 'local-assistant-1',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Draft created.',
        createdAt: '2026-06-01T10:00:05.000Z',
      },
      {
        id: 'local-user-2',
        sessionId: 'verso-session',
        role: 'user',
        content: 'Send it',
        createdAt: '2026-06-01T10:00:10.000Z',
      },
      {
        id: 'local-assistant-2',
        sessionId: 'verso-session',
        role: 'assistant',
        content: 'Sent.',
        createdAt: '2026-06-01T10:00:20.000Z',
      },
    ];

    const messages = mapHermesRowsToChatMessages([
      {
        id: 1,
        session_id: 'hermes-session',
        role: 'user',
        content: 'Create a draft',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962400,
      },
      {
        id: 2,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'call_draft',
          function: { name: 'mcp_verso_propose_message_draft', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1779962401,
      },
      {
        id: 3,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ draft: true }),
        tool_call_id: 'call_draft',
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962402,
      },
      {
        id: 4,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Draft created.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962403,
      },
      {
        id: 5,
        session_id: 'hermes-session',
        role: 'assistant',
        content: '',
        tool_call_id: null,
        tool_calls: JSON.stringify([{
          call_id: 'call_send',
          function: { name: 'mcp_verso_gmail_send_email', arguments: '{}' },
        }]),
        tool_name: null,
        timestamp: 1779962410,
      },
      {
        id: 6,
        session_id: 'hermes-session',
        role: 'tool',
        content: JSON.stringify({ sent: true }),
        tool_call_id: 'call_send',
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962415,
      },
      {
        id: 7,
        session_id: 'hermes-session',
        role: 'assistant',
        content: 'Sent.',
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        timestamp: 1779962420,
      },
    ], {
      hermesSessionId: 'hermes-session',
      versoSessionId: 'verso-session',
      localMessages,
    });

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Create a draft'],
      ['assistant', 'Draft created.'],
      ['user', 'Send it'],
      ['assistant', 'Sent.'],
    ]);
    expect(messages[1].steps?.map((step) => step.type === 'tool' ? step.name : step.type))
      .toEqual(['mcp_verso_propose_message_draft']);
    expect(messages[3].steps?.map((step) => step.type === 'tool' ? step.name : step.type))
      .toEqual(['mcp_verso_gmail_send_email']);
    expect(messages[1]).toMatchObject({
      startedAt: Date.parse('2026-06-01T10:00:00.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:05.000Z'),
    });
    expect(messages[3]).toMatchObject({
      startedAt: Date.parse('2026-06-01T10:00:10.000Z'),
      endedAt: Date.parse('2026-06-01T10:00:20.000Z'),
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  CentaurStreamTranslator,
  isCentaurBackend,
  readCentaurConfig,
  threadKeyForSession,
  type CentaurRawEvent,
} from '../src/integrations/centaur-client.ts';

function outputLine(payload: unknown): CentaurRawEvent {
  return { id: 1, event: 'session.output.line', data: JSON.stringify(payload) };
}

describe('readCentaurConfig', () => {
  it('is dormant when the backend flag is unset', () => {
    expect(isCentaurBackend({})).toBe(false);
    expect(readCentaurConfig({})).toBeNull();
    expect(readCentaurConfig({ VERSO_AGENT_BACKEND: 'hermes' })).toBeNull();
  });

  it('reads url, key and harness with a claudecode default', () => {
    const config = readCentaurConfig({
      VERSO_AGENT_BACKEND: 'centaur',
      VERSO_CENTAUR_URL: 'http://127.0.0.1:18080/',
      VERSO_CENTAUR_API_KEY: 'iak_test',
    });
    expect(config).toEqual({
      baseUrl: 'http://127.0.0.1:18080',
      apiKey: 'iak_test',
      harness: 'claudecode',
    });
  });

  it('honors an explicit harness and ignores an invalid one', () => {
    expect(readCentaurConfig({
      VERSO_AGENT_BACKEND: 'centaur',
      VERSO_CENTAUR_URL: 'http://h',
      VERSO_CENTAUR_HARNESS: 'codex',
    })?.harness).toBe('codex');
    expect(readCentaurConfig({
      VERSO_AGENT_BACKEND: 'centaur',
      VERSO_CENTAUR_URL: 'http://h',
      VERSO_CENTAUR_HARNESS: 'nonsense',
    })?.harness).toBe('claudecode');
  });

  it('throws when the backend is on but the url is missing', () => {
    expect(() => readCentaurConfig({ VERSO_AGENT_BACKEND: 'centaur' })).toThrow(/VERSO_CENTAUR_URL/);
  });
});

describe('threadKeyForSession', () => {
  it('namespaces the session under the verso source', () => {
    expect(threadKeyForSession('abc-123')).toBe('verso:abc-123');
  });
});

describe('CentaurStreamTranslator', () => {
  it('streams codex agent-message deltas and reconciles the completed item', () => {
    const t = new CentaurStreamTranslator();

    const started = t.handle({ id: 0, event: 'session.execution_started', data: '{}' });
    expect(started).toEqual([{ kind: 'status', message: 'Agent starting' }]);

    const d1 = t.handle(outputLine({ method: 'item/agentMessage/delta', params: { itemId: 'i1', delta: 'Hel' } }));
    const d2 = t.handle(outputLine({ method: 'item/agentMessage/delta', params: { itemId: 'i1', delta: 'lo' } }));
    expect(d1).toEqual([{ kind: 'text_delta', text: 'Hel' }]);
    expect(d2).toEqual([{ kind: 'text_delta', text: 'lo' }]);

    // The matching completed item must NOT re-emit text we already streamed.
    const completed = t.handle(outputLine({
      method: 'item/completed',
      params: { itemId: 'i1', item: { id: 'i1', type: 'agentMessage', text: 'Hello' } },
    }));
    expect(completed).toEqual([]);
    expect(t.composedAnswer()).toBe('Hello');
  });

  it('emits a completed agent message that never streamed deltas', () => {
    const t = new CentaurStreamTranslator();
    const completed = t.handle(outputLine({
      method: 'item/completed',
      params: { itemId: 'i9', item: { id: 'i9', type: 'agent_message', text: 'Direct answer' } },
    }));
    expect(completed).toEqual([{ kind: 'text_delta', text: 'Direct answer' }]);
    expect(t.composedAnswer()).toBe('Direct answer');
  });

  it('streams reasoning deltas', () => {
    const t = new CentaurStreamTranslator();
    const r = t.handle(outputLine({ method: 'item/reasoning/textDelta', params: { delta: 'thinking...' } }));
    expect(r).toEqual([{ kind: 'reasoning_delta', text: 'thinking...' }]);
  });

  it('maps assistant text and tool_use frames (anthropic dialect)', () => {
    const t = new CentaurStreamTranslator();
    const events = t.handle(outputLine({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'On it' },
          { type: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
        ],
      },
    }));
    expect(events).toEqual([
      { kind: 'text_delta', text: 'On it' },
      { kind: 'tool_use', id: 'tu1', name: 'search', input: { q: 'x' } },
    ]);
  });

  it('emits only the newly appended suffix for cumulative assistant messages', () => {
    const t = new CentaurStreamTranslator();
    t.handle(outputLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }));
    const second = t.handle(outputLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } }));
    expect(second).toEqual([{ kind: 'text_delta', text: ' world' }]);
    expect(t.composedAnswer()).toBe('Hello world');
  });

  it('maps tool_result frames', () => {
    const t = new CentaurStreamTranslator();
    const events = t.handle(outputLine({
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }],
    }));
    expect(events).toEqual([{ kind: 'tool_result', toolUseId: 'tu1', content: 'done' }]);
  });

  it('extracts result_text on completion', () => {
    const t = new CentaurStreamTranslator();
    const events = t.handle({
      id: 5,
      event: 'session.execution_completed',
      data: JSON.stringify({ execution_id: 'e1', result_text: 'final' }),
    });
    expect(events).toEqual([{ kind: 'completed', resultText: 'final' }]);
  });

  it('surfaces failures and stream errors', () => {
    const t = new CentaurStreamTranslator();
    expect(t.handle({ id: 6, event: 'session.execution_failed', data: JSON.stringify({ error: 'boom' }) }))
      .toEqual([{ kind: 'error', message: 'boom' }]);
    expect(t.handle({ id: 7, event: 'session.stream_error', data: JSON.stringify({ error: 'dropped' }) }))
      .toEqual([{ kind: 'error', message: 'dropped' }]);
  });

  it('ignores non-JSON and unrecognized output lines', () => {
    const t = new CentaurStreamTranslator();
    expect(t.handle({ id: 8, event: 'session.output.line', data: 'sandbox bootstrap notice' })).toEqual([]);
    expect(t.handle(outputLine({ method: 'turn/started', params: {} }))).toEqual([]);
  });
});

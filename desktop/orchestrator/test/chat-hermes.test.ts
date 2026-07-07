import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/http/server.ts';

describe('Hermes Chat Streaming', () => {
  let server: http.Server | null = null;
  let gateway: http.Server | null = null;
  let port = 0;
  let gatewayPort = 0;
  let requestLog: Array<Record<string, unknown>> = [];
  let breakConversationChain = false;
  let responseCounter = 0;
  let sessionCounter = 0;
  let messageCounter = 0;
  const storedResponses = new Map<string, { text: string; sessionId: string; history: Array<{ role: string; content: string }> }>();
  const conversations = new Map<string, string>();
  const sessions = new Map<string, Array<{ id: number; session_id: string; role: string; content: string; timestamp: number }>>();
  let envSnapshot: {
    VERSO_HERMES_GATEWAY_URL?: string;
    VERSO_CHAT_STORE_PATH?: string;
    VERSO_HERMES_MANAGED?: string;
    VERSO_MEMORY_DB_PATH?: string;
  } = {};

  beforeAll(async () => {
    envSnapshot = {
      VERSO_HERMES_GATEWAY_URL: process.env.VERSO_HERMES_GATEWAY_URL,
      VERSO_CHAT_STORE_PATH: process.env.VERSO_CHAT_STORE_PATH,
      VERSO_HERMES_MANAGED: process.env.VERSO_HERMES_MANAGED,
      VERSO_MEMORY_DB_PATH: process.env.VERSO_MEMORY_DB_PATH,
    };

    gateway = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', platform: 'hermes-agent' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          requestLog.push(parsed);

          const conversation = typeof parsed.conversation === 'string' ? parsed.conversation : null;
          const explicitHistory = Array.isArray(parsed.conversation_history)
            ? parsed.conversation_history as Array<{ role?: unknown; content?: unknown }>
            : null;
          const previousResponseId = typeof parsed.previous_response_id === 'string'
            ? parsed.previous_response_id
            : conversation ? conversations.get(conversation) ?? null : null;

          if (previousResponseId && (breakConversationChain || !storedResponses.has(previousResponseId)) && !explicitHistory) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `Previous response not found: ${previousResponseId}`,
                type: 'invalid_request_error',
              },
            }));
            return;
          }

          const previous = previousResponseId ? storedResponses.get(previousResponseId) ?? null : null;
          const input = typeof parsed.input === 'string' ? parsed.input : '';
          const sessionId = previous?.sessionId ?? `sess-test-${++sessionCounter}`;
          const history = explicitHistory
            ? explicitHistory.map((message) => ({
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: typeof message.content === 'string' ? message.content : '',
            }))
            : previous?.history ?? [];
          const outputText = previous && !explicitHistory
            ? `Follow-up: ${input}`
            : explicitHistory && explicitHistory.length > 0
              ? `Recovered: ${input}`
              : `Hermes Result: ${input}`;
          const responseId = `resp-test-${++responseCounter}`;
          const fullHistory = [...history, { role: 'user', content: input }, { role: 'assistant', content: outputText }];

          storedResponses.set(responseId, {
            text: outputText,
            sessionId,
            history: fullHistory,
          });
          if (conversation) {
            conversations.set(conversation, responseId);
          }
          sessions.set(sessionId, fullHistory.map((message) => ({
            id: ++messageCounter,
            session_id: sessionId,
            role: message.role,
            content: message.content,
            timestamp: Date.now() / 1000 + (messageCounter / 1000),
          })));

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Hermes-Session-Id': sessionId,
          });
          writeResponseStream(res, responseId, outputText, 'Thinking through inflation drivers.');
        });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const messages = sessions.get(sessionId);
        if (!messages) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Session not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: sessionId,
          title: null,
          started_at: messages[0]?.timestamp ?? Date.now() / 1000,
          last_active: messages[messages.length - 1]?.timestamp ?? Date.now() / 1000,
          message_count: messages.length,
        }));
        return;
      }

      const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && sessionMessagesMatch) {
        const sessionId = decodeURIComponent(sessionMessagesMatch[1]);
        const messages = sessions.get(sessionId);
        if (!messages) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'Session not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session_id: sessionId, messages }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await new Promise<void>((resolve) => {
      gateway!.listen(0, '127.0.0.1', () => {
        const addr = gateway!.address() as { port: number };
        gatewayPort = addr.port;
        resolve();
      });
    });

    process.env.VERSO_HERMES_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    process.env.VERSO_CHAT_STORE_PATH = `/tmp/verso-chat-test-${process.pid}.sqlite`;
    process.env.VERSO_HERMES_MANAGED = 'false';
    // Memory defaults on; keep the test's SQLite store out of the real
    // profile-sibling location.
    process.env.VERSO_MEMORY_DB_PATH = `/tmp/verso-memory-test-${process.pid}.sqlite`;

    const result = await startServer({ port: 0 });
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      server = null;
    }
    if (gateway) {
      gateway.close();
      gateway = null;
    }

    process.env.VERSO_HERMES_GATEWAY_URL = envSnapshot.VERSO_HERMES_GATEWAY_URL;
    process.env.VERSO_CHAT_STORE_PATH = envSnapshot.VERSO_CHAT_STORE_PATH;
    process.env.VERSO_HERMES_MANAGED = envSnapshot.VERSO_HERMES_MANAGED;
    if (envSnapshot.VERSO_MEMORY_DB_PATH === undefined) delete process.env.VERSO_MEMORY_DB_PATH;
    else process.env.VERSO_MEMORY_DB_PATH = envSnapshot.VERSO_MEMORY_DB_PATH;
  });

  function url(pathname: string): string {
    return `http://127.0.0.1:${port}${pathname}`;
  }

  async function fetchJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(pathname), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  it('streams a Hermes response through Hermes-backed chat session messages', async () => {
    requestLog = [];
    breakConversationChain = false;
    storedResponses.clear();
    conversations.clear();
    sessions.clear();
    responseCounter = 0;
    sessionCounter = 0;
    messageCounter = 0;

    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Inflation' }),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Give me an inflation summary' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toContain('"type":"reasoning_delta"');
    expect(body).toContain('Thinking through inflation drivers.');
    expect(body).toContain('content_block_delta');
    expect(body).toContain('Hermes Result: Give me an inflation summary');
    expect(body).toContain('"type":"done"');
    expect(body).toContain(`"session_id":"${sessionId}"`);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.messages).toHaveLength(2);
    expect(messages.body.messages[0].role).toBe('user');
    expect(messages.body.messages[1].role).toBe('assistant');
    expect(requestLog).toHaveLength(1);
    expect(requestLog[0].conversation).toBe(sessionId);
    expect(requestLog[0].instructions).toBeUndefined();
    expect(requestLog[0].conversation_history).toBeUndefined();
  });

  it('recovers by replaying Hermes-backed chat history when conversation chaining breaks', async () => {
    requestLog = [];
    breakConversationChain = false;
    storedResponses.clear();
    conversations.clear();
    sessions.clear();
    responseCounter = 0;
    sessionCounter = 0;
    messageCounter = 0;

    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Recovery' }),
    });
    const sessionId = created.body.session.id as string;

    await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'First turn' }),
    });

    breakConversationChain = true;

    const res = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Second turn' }),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Recovering chat context');
    expect(body).toContain('Recovered: Second turn');

    expect(requestLog).toHaveLength(3);
    expect(requestLog[1].conversation).toBe(sessionId);
    expect(requestLog[1].instructions).toBeUndefined();
    expect(requestLog[1].conversation_history).toBeUndefined();
    expect(requestLog[2].instructions).toBeUndefined();
    expect(Array.isArray(requestLog[2].conversation_history)).toBe(true);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.body.messages).toHaveLength(4);
    expect(messages.body.messages[3].content).toBe('Recovered: Second turn');
  });

  it('marks a memory extraction job pending after a chat turn', async () => {
    requestLog = [];
    breakConversationChain = false;
    storedResponses.clear();
    conversations.clear();
    sessions.clear();
    responseCounter = 0;
    sessionCounter = 0;
    messageCounter = 0;

    const created = await fetchJson('/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Memory' }),
    });
    const sessionId = created.body.session.id as string;

    const res = await fetch(url(`/chat/sessions/${sessionId}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'I had a meeting with Sarah Chen from Acme Corp. She said Acme is evaluating Verso for customer support notes.',
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
    const diagnostics = await fetchJson('/diagnostics');

    expect(requestLog[0].conversation).toBe(sessionId);
    expect(requestLog).toHaveLength(1);
    expect(diagnostics.body.chat.memoryExtraction.enabled).toBe(true);
    expect(diagnostics.body.chat.memoryExtraction.idleThresholdMs).toBe(120000);
    // Memory is enabled by default, so sessions from the earlier tests in
    // this file are pending too — assert at least this one.
    expect(diagnostics.body.chat.memoryExtraction.counts.pending).toBeGreaterThanOrEqual(1);
    expect(diagnostics.body.memory).toMatchObject({ backend: 'lexical', state: 'ready' });
  });
});

function writeResponseStream(
  res: http.ServerResponse,
  responseId: string,
  outputText: string,
  reasoningText?: string,
): void {
  const messageId = `msg-${responseId}`;
  writeEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      status: 'in_progress',
      created_at: Math.floor(Date.now() / 1000),
      model: 'hermes-agent',
      output: [],
    },
    sequence_number: 0,
  });
  writeEvent(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      id: messageId,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    },
    sequence_number: 1,
  });
  if (reasoningText) {
    writeEvent(res, 'hermes.reasoning.delta', {
      type: 'hermes.reasoning.delta',
      item_id: messageId,
      delta: reasoningText,
      sequence_number: 2,
    });
  }
  writeEvent(res, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    delta: outputText,
    logprobs: [],
    sequence_number: 3,
  });
  writeEvent(res, 'response.output_text.done', {
    type: 'response.output_text.done',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text: outputText,
    logprobs: [],
    sequence_number: 4,
  });
  writeEvent(res, 'response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }],
    },
    sequence_number: 5,
  });
  writeEvent(res, 'response.completed', {
    type: 'response.completed',
    response: buildCompletedResponse(responseId, outputText),
    sequence_number: 6,
  });
  res.end();
}

function buildCompletedResponse(responseId: string, outputText: string) {
  return {
    id: responseId,
    object: 'response',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    model: 'hermes-agent',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }],
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    },
  };
}

function writeEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

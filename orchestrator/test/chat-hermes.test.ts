import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { startServer } from '../src/http/server.ts';

describe('Hermes Chat Streaming', () => {
  let server: http.Server | null = null;
  let gateway: http.Server | null = null;
  let port = 0;
  let gatewayPort = 0;
  let requestLog: Array<Record<string, unknown>> = [];
  let forgetStoredResponses = false;
  let responseCounter = 0;
  const storedResponses = new Map<string, { text: string }>();
  let envSnapshot: {
    VERVO_HERMES_GATEWAY_URL?: string;
    VERVO_CHAT_STORE_PATH?: string;
    VERVO_HERMES_MANAGED?: string;
  } = {};

  beforeAll(async () => {
    envSnapshot = {
      VERVO_HERMES_GATEWAY_URL: process.env.VERVO_HERMES_GATEWAY_URL,
      VERVO_CHAT_STORE_PATH: process.env.VERVO_CHAT_STORE_PATH,
      VERVO_HERMES_MANAGED: process.env.VERVO_HERMES_MANAGED,
    };

    gateway = http.createServer((req, res) => {
      const url = req.url || '';

      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', platform: 'hermes-agent' }));
        return;
      }

      if (req.method === 'POST' && url === '/v1/responses') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          requestLog.push(parsed);

          const previousResponseId = typeof parsed.previous_response_id === 'string'
            ? parsed.previous_response_id
            : null;
          if (previousResponseId && (forgetStoredResponses || !storedResponses.has(previousResponseId))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                message: `Previous response not found: ${previousResponseId}`,
                type: 'invalid_request_error',
              },
            }));
            return;
          }

          const input = typeof parsed.input === 'string' ? parsed.input : '';
          const outputText = previousResponseId
            ? `Follow-up: ${input}`
            : Array.isArray(parsed.conversation_history) && parsed.conversation_history.length > 0
              ? `Recovered: ${input}`
              : `Hermes Result: ${input}`;
          const responseId = `resp-test-${++responseCounter}`;
          storedResponses.set(responseId, { text: outputText });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          writeResponseStream(res, responseId, outputText);
        });
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

    process.env.VERVO_HERMES_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    process.env.VERVO_CHAT_STORE_PATH = `/tmp/vervo-chat-test-${process.pid}.json`;
    process.env.VERVO_HERMES_MANAGED = 'false';

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

    process.env.VERVO_HERMES_GATEWAY_URL = envSnapshot.VERVO_HERMES_GATEWAY_URL;
    process.env.VERVO_CHAT_STORE_PATH = envSnapshot.VERVO_CHAT_STORE_PATH;
    process.env.VERVO_HERMES_MANAGED = envSnapshot.VERVO_HERMES_MANAGED;
  });

  function url(pathname: string): string {
    return `http://127.0.0.1:${port}${pathname}`;
  }

  async function fetchJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(url(pathname), init);
    const body = await res.json();
    return { status: res.status, body };
  }

  it('streams a Hermes response through chat session messages', async () => {
    requestLog = [];
    forgetStoredResponses = false;
    storedResponses.clear();
    responseCounter = 0;

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
    expect(requestLog[0].previous_response_id).toBeUndefined();
  });

  it('recovers by replaying chat history when Hermes loses the previous response cursor', async () => {
    requestLog = [];
    forgetStoredResponses = false;
    storedResponses.clear();
    responseCounter = 0;

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

    forgetStoredResponses = true;

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
    expect(typeof requestLog[1].previous_response_id).toBe('string');
    expect(requestLog[2].previous_response_id).toBeUndefined();
    expect(Array.isArray(requestLog[2].conversation_history)).toBe(true);

    const messages = await fetchJson(`/chat/sessions/${sessionId}/messages`);
    expect(messages.body.messages).toHaveLength(4);
    expect(messages.body.messages[3].content).toBe('Recovered: Second turn');
  });
});

function writeResponseStream(res: http.ServerResponse, responseId: string, outputText: string): void {
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
  writeEvent(res, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    delta: outputText,
    logprobs: [],
    sequence_number: 2,
  });
  writeEvent(res, 'response.output_text.done', {
    type: 'response.output_text.done',
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text: outputText,
    logprobs: [],
    sequence_number: 3,
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
    sequence_number: 4,
  });
  writeEvent(res, 'response.completed', {
    type: 'response.completed',
    response: {
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
        input_tokens: 12,
        output_tokens: 4,
        total_tokens: 16,
      },
    },
    sequence_number: 5,
  });
  res.end();
}

function writeEvent(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

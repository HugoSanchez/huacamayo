import http from 'node:http';

const port = parseInt(process.env.API_SERVER_PORT || process.env.PORT || '8642', 10);
const host = process.env.API_SERVER_HOST || process.env.HOST || '127.0.0.1';

let responseCounter = 0;
let sessionCounter = 0;
let messageCounter = 0;
const responses = new Map();
const conversations = new Map();
const sessions = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${port}`);

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
      const parsed = JSON.parse(body || '{}');
      const explicitHistory = Array.isArray(parsed.conversation_history) ? parsed.conversation_history : null;
      const conversation = typeof parsed.conversation === 'string' ? parsed.conversation : null;
      const previousResponseId = typeof parsed.previous_response_id === 'string'
        ? parsed.previous_response_id
        : conversation ? conversations.get(conversation) ?? null : null;

      if (previousResponseId && !responses.has(previousResponseId) && !explicitHistory) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `Previous response not found: ${previousResponseId}`,
            type: 'invalid_request_error',
          },
        }));
        return;
      }

      const previous = previousResponseId ? responses.get(previousResponseId) ?? null : null;
      const input = typeof parsed.input === 'string' ? parsed.input : '';
      const sessionId = previous?.sessionId ?? `sess-managed-${++sessionCounter}`;
      const history = explicitHistory ? normalizeHistory(explicitHistory) : previous?.conversationHistory ?? [];
      const outputText = previous && !explicitHistory
        ? `Managed follow-up: ${input}`
        : explicitHistory && explicitHistory.length > 0
          ? `Managed recovery: ${input}`
          : `Managed Hermes: ${input}`;
      const fullHistory = [...history, { role: 'user', content: input }, { role: 'assistant', content: outputText }];
      const responseId = `resp-managed-${++responseCounter}`;

      responses.set(responseId, { sessionId, conversationHistory: fullHistory });
      if (conversation) {
        conversations.set(conversation, responseId);
      }
      persistSession(sessionId, fullHistory);

      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Hermes-Session-Id': sessionId,
        });
        writeResponseStream(res, responseId, outputText);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Hermes-Session-Id': sessionId,
      });
      res.end(JSON.stringify(buildCompletedResponse(responseId, outputText)));
    });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionMatch) {
    const session = sessions.get(decodeURIComponent(sessionMatch[1]));
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: session.id,
      title: session.title,
      started_at: session.startedAt,
      last_active: session.lastActive,
      message_count: session.messages.length,
    }));
    return;
  }

  const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'GET' && sessionMessagesMatch) {
    const session = sessions.get(decodeURIComponent(sessionMessagesMatch[1]));
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session_id: session.id, messages: session.messages }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = [...sessions.values()]
      .sort((a, b) => b.lastActive - a.lastActive)
      .map((session) => ({
        id: session.id,
        title: session.title,
        started_at: session.startedAt,
        last_active: session.lastActive,
        message_count: session.messages.length,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: list, total: list.length, limit: list.length, offset: 0 }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ status: 'ready', port, host }));
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function persistSession(sessionId, fullHistory) {
  const now = Date.now() / 1000;
  const existing = sessions.get(sessionId);
  const startedAt = existing?.startedAt ?? now;
  sessions.set(sessionId, {
    id: sessionId,
    title: existing?.title ?? null,
    startedAt,
    lastActive: now,
    messages: fullHistory.map((message) => ({
      id: ++messageCounter,
      session_id: sessionId,
      role: message.role,
      content: message.content,
      timestamp: startedAt + (messageCounter / 1000),
    })),
  });
}

function normalizeHistory(history) {
  return history
    .filter((message) => message && typeof message === 'object')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message.content === 'string' ? message.content : '',
    }));
}

function writeResponseStream(res, responseId, outputText) {
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
    response: buildCompletedResponse(responseId, outputText),
    sequence_number: 5,
  });
  res.end();
}

function buildCompletedResponse(responseId, outputText) {
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

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

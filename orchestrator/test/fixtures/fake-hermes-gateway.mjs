import http from 'node:http';

const port = parseInt(process.env.API_SERVER_PORT || process.env.PORT || '8642', 10);
const host = process.env.API_SERVER_HOST || process.env.HOST || '127.0.0.1';

let counter = 0;
const responses = new Map();

const server = http.createServer((req, res) => {
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
      const parsed = JSON.parse(body || '{}');
      const input = typeof parsed.input === 'string' ? parsed.input : '';

      if (parsed.previous_response_id && !responses.has(parsed.previous_response_id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: `Previous response not found: ${parsed.previous_response_id}`,
            type: 'invalid_request_error',
          },
        }));
        return;
      }

      const responseId = `resp-managed-${++counter}`;
      const outputText = parsed.previous_response_id
        ? `Managed follow-up: ${input}`
        : Array.isArray(parsed.conversation_history) && parsed.conversation_history.length > 0
          ? `Managed recovery: ${input}`
          : 'Managed Hermes';

      responses.set(responseId, {
        id: responseId,
        outputText,
      });

      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        writeResponseStream(res, responseId, outputText);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildCompletedResponse(responseId, outputText)));
    });
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

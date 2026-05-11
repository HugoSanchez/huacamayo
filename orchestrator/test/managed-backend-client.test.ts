import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ManagedBackendClient, ManagedBackendError } from '../src/integrations/managed-backend-client.ts';

let backendServer: http.Server | null = null;
let backendPort = 0;
let nextRuntimeStatus = 200;
let nextInferenceStatus = 200;
let nextRuntimeBody: unknown = null;
let nextInferenceChunks: string[] = [];

beforeAll(async () => {
  backendPort = await allocatePort();
  backendServer = await startFakeBackend(backendPort);
});

afterAll(async () => {
  if (backendServer) {
    await new Promise<void>((resolve) => backendServer!.close(() => resolve()));
    backendServer = null;
  }
});

function freshClient(opts: { withSession?: boolean } = {}): ManagedBackendClient {
  const client = new ManagedBackendClient(`http://127.0.0.1:${backendPort}`);
  if (opts.withSession !== false) {
    client.setSession({
      token: 'token-test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      userId: 'usr_test',
      email: null,
      displayName: null,
      receivedAt: new Date().toISOString(),
    });
  }
  return client;
}

describe('ManagedBackendClient.getRuntimeConfig', () => {
  it('returns the parsed runtime-config payload', async () => {
    nextRuntimeStatus = 200;
    nextRuntimeBody = {
      defaultModel: 'anthropic/opus-4.7',
      allowedModels: ['anthropic/opus-4.7', 'openai/gpt-5.4'],
    };

    const client = freshClient({ withSession: false });
    const config = await client.getRuntimeConfig();
    expect(config).toEqual({
      defaultModel: 'anthropic/opus-4.7',
      allowedModels: ['anthropic/opus-4.7', 'openai/gpt-5.4'],
    });
  });

  it('throws ManagedBackendError on a 5xx response', async () => {
    nextRuntimeStatus = 503;
    nextRuntimeBody = { error: 'service_unavailable', message: 'Backend down for maintenance.' };

    const client = freshClient({ withSession: false });
    const error = await client.getRuntimeConfig().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).status).toBe(503);
    expect((error as ManagedBackendError).code).toBe('service_unavailable');
  });

  it('rejects with malformed_response when the body is missing fields', async () => {
    nextRuntimeStatus = 200;
    nextRuntimeBody = { defaultModel: 'foo' };

    const client = freshClient({ withSession: false });
    const error = await client.getRuntimeConfig().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).code).toBe('malformed_response');
  });
});

describe('ManagedBackendClient.streamInference', () => {
  it('returns the upstream body and the inference request id header on success', async () => {
    nextInferenceStatus = 200;
    nextInferenceChunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const client = freshClient();
    const stream = await client.streamInference({
      model: 'anthropic/opus-4.7',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(stream.inferenceRequestId).toBe('inf_test_123');

    const text = await readStreamToString(stream.body);
    expect(text).toContain('hi');
    expect(text).toContain('[DONE]');
  });

  it('throws ManagedBackendError when the backend returns 401', async () => {
    nextInferenceStatus = 401;
    nextInferenceChunks = [];

    const client = freshClient();
    const error = await client
      .streamInference({ model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).status).toBe(401);
  });

  it('throws missing_session when no session has been pushed yet', async () => {
    const client = new ManagedBackendClient(`http://127.0.0.1:${backendPort}`);
    client.setSession(null);

    const error = await client
      .streamInference({ model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).code).toBe('missing_session');
  });

  it('throws expired_session when the local expiry is in the past', async () => {
    const client = new ManagedBackendClient(`http://127.0.0.1:${backendPort}`);
    client.setSession({
      token: 'token-test',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      userId: 'usr_test',
      email: null,
      displayName: null,
      receivedAt: new Date().toISOString(),
    });

    const error = await client
      .streamInference({ model: 'anthropic/opus-4.7', messages: [{ role: 'user', content: 'hi' }] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ManagedBackendError);
    expect((error as ManagedBackendError).code).toBe('expired_session');
  });
});

async function readStreamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function startFakeBackend(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/v1/runtime-config') {
      res.writeHead(nextRuntimeStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextRuntimeBody));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (nextInferenceStatus !== 200) {
        res.writeHead(nextInferenceStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_session', message: 'Session is not valid.' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'X-Inference-Request-Id': 'inf_test_123',
      });
      for (const chunk of nextInferenceChunks) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function allocatePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { buildLlmProxyRoutes } from '../src/http/llm-proxy.ts';
import { dispatch } from '../src/http/router.ts';
import type { ManagedBackendClient, ManagedSessionRecord } from '../src/integrations/managed-backend-client.ts';

const activeSession: ManagedSessionRecord = {
  token: 'session-token',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  userId: 'usr_test',
  email: null,
  displayName: null,
  receivedAt: new Date().toISOString(),
};

describe('LLM proxy', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('normalizes backend JSON errors for OpenAI-compatible clients and forwards Retry-After', async () => {
    const upstream = new Response(JSON.stringify({
      error: 'provider_rate_limited',
      message: 'OpenRouter rate limited the request. Retry after 60s.',
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
      },
    });
    const url = await startProxy(upstream);

    const response = await fetch(`${url}/llm/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({
      error: {
        message: 'OpenRouter rate limited the request. Retry after 60s.',
        type: 'rate_limit_error',
        code: 'provider_rate_limited',
      },
    });
  });

  it('adapts non-streaming /responses calls into a completed Responses API payload', async () => {
    const sseBody = [
      'data: {"id":"chatcmpl_123","choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"id":"chatcmpl_123","choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const upstream = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const url = await startProxy(upstream);

    const response = await fetch(`${url}/llm/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-5.4',
        instructions: 'Summarize this.',
        input: [{ role: 'user', content: 'Hi there' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.stringMatching(/^resp_/),
      object: 'response',
      model: 'openai/gpt-5.4',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Hello world',
            },
          ],
        },
      ],
    });
  });

  it('translates Responses function tools and returns chat tool calls as Responses output items', async () => {
    const sseBody = [
      'data: {"id":"chatcmpl_123","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"mcp_verso_apps_list_connections","arguments":""}}]}}]}',
      '',
      'data: {"id":"chatcmpl_123","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"toolkit_slug\\":\\"googledrive\\"}"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const upstream = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    let forwardedBody: Record<string, unknown> | null = null;
    const url = await startProxy(upstream, (body) => {
      forwardedBody = body;
    });

    const response = await fetch(`${url}/llm/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-5.4',
        input: [
          { role: 'user', content: 'List my Drive connections.' },
          {
            type: 'function_call',
            call_id: 'call_prev',
            name: 'mcp_verso_apps_list_connections',
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_prev',
            output: '{"connections":[]}',
          },
        ],
        tools: [{
          type: 'function',
          name: 'mcp_verso_apps_list_connections',
          description: 'List connected apps.',
          parameters: { type: 'object', properties: {} },
        }],
        tool_choice: { type: 'function', name: 'mcp_verso_apps_list_connections' },
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(forwardedBody).toMatchObject({
      tools: [{
        type: 'function',
        function: {
          name: 'mcp_verso_apps_list_connections',
          description: 'List connected apps.',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'mcp_verso_apps_list_connections' },
      },
    });
    expect((forwardedBody?.messages as unknown[])[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{
        id: 'call_prev',
        type: 'function',
        function: {
          name: 'mcp_verso_apps_list_connections',
          arguments: '{}',
        },
      }],
    });
    expect((forwardedBody?.messages as unknown[])[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_prev',
      content: '{"connections":[]}',
    });

    expect(await response.json()).toEqual({
      id: expect.stringMatching(/^resp_/),
      object: 'response',
      model: 'openai/gpt-5.4',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_call_abc',
        call_id: 'call_abc',
        name: 'mcp_verso_apps_list_connections',
        arguments: '{"toolkit_slug":"googledrive"}',
        status: 'completed',
      }],
    });
  });

  it('returns 501 for streaming /responses calls until that surface is implemented', async () => {
    const upstream = new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const url = await startProxy(upstream);

    const response = await fetch(`${url}/llm/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-5.4',
        input: 'Hi',
        stream: true,
      }),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: {
        code: 'unsupported',
        message: 'Streaming /responses is not implemented by the local managed proxy.',
      },
    });
  });

  async function startProxy(
    upstream: Response,
    onForward?: (body: Record<string, unknown>) => void,
  ): Promise<string> {
    const managedBackend = {
      getStoredSession: () => activeSession,
      forwardChatCompletion: async (body: Record<string, unknown>) => {
        onForward?.(body);
        return upstream;
      },
    } as unknown as ManagedBackendClient;
    const routes = buildLlmProxyRoutes(managedBackend);
    server = http.createServer((req, res) => {
      void dispatch(routes, req, res);
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind proxy test server.');
    }
    return `http://127.0.0.1:${address.port}`;
  }
});

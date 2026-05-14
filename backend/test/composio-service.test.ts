import { afterEach, describe, expect, test, vi } from 'vitest';
import { ComposioService } from '../src/composio/service.ts';

const slackSearchTool = {
  slug: 'SLACK_SEARCH_MESSAGES',
  name: 'Search messages',
  description: null,
  toolkit: { slug: 'slack', name: 'Slack' },
  inputParameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
    },
  },
};

function buildService(rawTool = slackSearchTool) {
  const execute = vi.fn(async () => ({
    data: { ok: true },
    error: null,
    logId: 'log_1',
  }));
  const fakeClient = {
    tools: {
      getRawComposioToolBySlug: vi.fn(async () => rawTool),
    },
    create: vi.fn(async () => ({
      sessionId: 'session_1',
      search: vi.fn(),
      execute,
    })),
  };
  const service = new ComposioService('test-key');
  Object.assign(service as unknown as Record<string, unknown>, { client: fakeClient });
  return { service, fakeClient, execute };
}

describe('ComposioService tool execution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('uses SDK schema lookup and Tool Router session execution instead of raw REST execute', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('raw fetch should not be used'));
    const { service, fakeClient, execute } = buildService();

    const result = await service.executeTool(' user_1 ', 'SLACK_SEARCH_MESSAGES', { query: 'katana' });

    expect(result).toEqual({ data: { ok: true }, error: null, logId: 'log_1' });
    expect(fakeClient.tools.getRawComposioToolBySlug).toHaveBeenCalledWith('SLACK_SEARCH_MESSAGES');
    expect(fakeClient.create).toHaveBeenCalledWith('user_1', expect.objectContaining({ manageConnections: false }));
    expect(execute).toHaveBeenCalledWith('SLACK_SEARCH_MESSAGES', { query: 'katana' });
    const composioRestCalls = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('backend.composio.dev/api/v3/tools'));
    expect(composioRestCalls).toEqual([]);
  });

  test('rejects missing arguments before schema lookup or execution', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { service, fakeClient, execute } = buildService();

    await expect(service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', undefined))
      .rejects.toMatchObject({ status: 400 });

    expect(fakeClient.tools.getRawComposioToolBySlug).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test('rejects empty arguments when the Composio schema has required fields', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { service, execute } = buildService();

    await expect(service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', {}))
      .rejects.toMatchObject({
        status: 400,
        message: 'Missing required argument "query" for SLACK_SEARCH_MESSAGES.',
      });

    expect(execute).not.toHaveBeenCalled();
  });
});

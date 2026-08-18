import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ComposioService,
  type ComposioClient,
  type ComposioServiceDependencies,
} from '../src/composio/service.ts';

const slackSearchTool = {
  slug: 'SLACK_SEARCH_MESSAGES',
  name: 'Search messages',
  description: null,
  toolkit: { slug: 'slack', name: 'Slack' },
  inputParameters: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
};

function createFixture(dependencies: Omit<ComposioServiceDependencies, 'client'> = {}) {
  const execute = vi.fn(async () => ({ data: { ok: true }, error: null, logId: 'log_1' }));
  const search = vi.fn(async () => ({ results: [] }));
  const authorize = vi.fn(async () => ({
    id: 'request_1',
    status: 'PENDING',
    redirectUrl: 'https://connect.example.test',
  }));
  const client = {
    connectedAccounts: {
      list: vi.fn(async () => ({ items: [] })),
      get: vi.fn(async (id: string) => ({
        id,
        status: 'ACTIVE',
        toolkit: { slug: 'slack' },
      })),
      disable: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    toolkits: {
      get: vi.fn(async (slug: string) => ({
        slug,
        name: slug === 'slack' ? 'Slack' : slug,
        meta: { description: null, logo: null, categories: [] },
        authConfigDetails: [],
        composioManagedAuthSchemes: [],
      })),
    },
    tools: {
      getRawComposioToolBySlug: vi.fn(async () => slackSearchTool),
    },
    create: vi.fn(async () => ({ sessionId: 'session_1', search, execute, authorize })),
  } as unknown as ComposioClient;
  const fetch = vi.fn(async () => {
    throw new Error('Unexpected Composio REST request');
  }) as unknown as typeof globalThis.fetch;
  const service = new ComposioService('test-key', { client, fetch, ...dependencies });
  return { service, client, fetch, execute, search, authorize };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ComposioService tool execution', () => {
  test('uses injected SDK schema lookup and Tool Router execution without raw REST', async () => {
    const log = vi.fn();
    const fixture = createFixture({ log });

    await expect(fixture.service.executeTool(' user_1 ', 'SLACK_SEARCH_MESSAGES', { query: 'katana' }))
      .resolves.toEqual({ data: { ok: true }, error: null, logId: 'log_1' });

    expect(fixture.client.tools.getRawComposioToolBySlug).toHaveBeenCalledWith('SLACK_SEARCH_MESSAGES');
    expect(fixture.client.create).toHaveBeenCalledWith('user_1', { manageConnections: false });
    expect(fixture.execute).toHaveBeenCalledWith('SLACK_SEARCH_MESSAGES', { query: 'katana' });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test('rejects missing arguments before schema lookup or execution', async () => {
    const fixture = createFixture({ log: vi.fn() });
    await expect(fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', undefined))
      .rejects.toMatchObject({ status: 400 });
    expect(fixture.client.tools.getRawComposioToolBySlug).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test('rejects empty arguments when the schema has required fields', async () => {
    const fixture = createFixture({ log: vi.fn() });
    await expect(fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', {}))
      .rejects.toMatchObject({
        status: 400,
        message: 'Missing required argument "query" for SLACK_SEARCH_MESSAGES.',
      });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test('degrades gracefully when the SDK rejects a malformed upstream schema', async () => {
    const log = vi.fn();
    const fixture = createFixture({ log });
    vi.mocked(fixture.client.tools.getRawComposioToolBySlug)
      .mockRejectedValue(new Error('invalid_type at outputParameters.items'));

    await expect(fixture.service.getToolSchemas('user_1', ['BROKEN_TOOL']))
      .resolves.toEqual([expect.objectContaining({
        slug: 'BROKEN_TOOL',
        inputParameters: null,
        toolkitSlug: null,
      })]);
    await expect(fixture.service.executeTool('user_1', 'BROKEN_TOOL', { bestGuess: true }))
      .resolves.toMatchObject({ data: { ok: true }, error: null });
    expect(fixture.execute).toHaveBeenCalledWith('BROKEN_TOOL', { bestGuess: true });
    expect(log).toHaveBeenCalledWith('composio.getSchemas.schemaUnavailable', expect.any(Object));
    expect(log).toHaveBeenCalledWith('composio.execute.schemaUnavailable', expect.any(Object));
  });

  test('rejects structurally invalid raw schemas as an upstream error', async () => {
    const fixture = createFixture({ log: vi.fn() });
    vi.mocked(fixture.client.tools.getRawComposioToolBySlug).mockResolvedValue(null);
    await expect(fixture.service.getToolSchemas('user_1', ['BROKEN_TOOL']))
      .rejects.toMatchObject({ status: 502, message: 'Composio returned an invalid schema for BROKEN_TOOL.' });
  });
});

describe('ComposioService caching and invalidation', () => {
  test('coalesces concurrent session creation and caches normalized schemas', async () => {
    const fixture = createFixture({ log: vi.fn() });
    await Promise.all([
      fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'one' }),
      fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'two' }),
    ]);
    expect(fixture.client.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.tools.getRawComposioToolBySlug).toHaveBeenCalledTimes(1);

    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'three' });
    expect(fixture.client.create).toHaveBeenCalledTimes(1);
    expect(fixture.client.tools.getRawComposioToolBySlug).toHaveBeenCalledTimes(1);
  });

  test('expires sessions using the injected clock', async () => {
    let now = 100;
    const fixture = createFixture({ now: () => now, sessionTtlMs: 50, log: vi.fn() });
    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'one' });
    now = 149;
    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'two' });
    expect(fixture.client.create).toHaveBeenCalledTimes(1);
    now = 150;
    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'three' });
    expect(fixture.client.create).toHaveBeenCalledTimes(2);
  });

  test('deleting a connection invalidates only that user session', async () => {
    const fixture = createFixture({ log: vi.fn() });
    vi.mocked(fixture.client.connectedAccounts.list).mockImplementation(async ({ userIds }) => ({
      items: [{ id: userIds[0] === 'user_1' ? 'ca_1' : 'ca_2', toolkit: { slug: 'slack' }, status: 'ACTIVE' }],
    }));
    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'one' });
    await fixture.service.executeTool('user_2', 'SLACK_SEARCH_MESSAGES', { query: 'two' });
    await fixture.service.deleteConnection('user_1', 'ca_1');
    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'three' });
    await fixture.service.executeTool('user_2', 'SLACK_SEARCH_MESSAGES', { query: 'four' });
    expect(fixture.client.create).toHaveBeenCalledTimes(3);
    expect(fixture.client.create).toHaveBeenNthCalledWith(3, 'user_1', { manageConnections: false });
  });
});

describe('ComposioService search fallback and policy', () => {
  test('falls back to the toolkit catalog when Tool Router schema validation fails', async () => {
    const fixture = createFixture({ log: vi.fn() });
    fixture.search.mockRejectedValue(new Error('invalid_literal in outputParameters'));
    vi.mocked(fixture.fetch).mockResolvedValue(new Response(JSON.stringify({
      items: [{
        slug: 'SLACK_SEARCH_MESSAGES',
        name: 'Search messages',
        description: 'Find matching Slack messages',
        toolkit: { slug: 'slack', name: 'Slack' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(fixture.service.searchTools('user_1', 'messages', ['slack']))
      .resolves.toEqual([expect.objectContaining({ slug: 'SLACK_SEARCH_MESSAGES', toolkitSlug: 'slack' })]);
    expect(fixture.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/v3/tools?toolkit_slug=slack'), expect.any(Object));
  });

  test('does not hide non-schema Tool Router failures behind fallback', async () => {
    const fixture = createFixture({ log: vi.fn() });
    fixture.search.mockRejectedValue(new Error('Composio unavailable'));
    await expect(fixture.service.searchTools('user_1', 'messages', ['slack']))
      .rejects.toThrow('Composio unavailable');
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  test('enforces the allowlist for exact toolkit resolution and Tool Router scope', async () => {
    const fixture = createFixture({
      allowedToolkits: 'slack',
      toolRouterToolkits: 'slack,github',
      log: vi.fn(),
    });
    vi.mocked(fixture.client.toolkits.get).mockImplementation(async (slug) => ({
      slug,
      name: slug,
      meta: { description: null, logo: null, categories: [] },
      authConfigDetails: [],
      composioManagedAuthSchemes: [],
    }));

    await expect(fixture.service.requestConnection('user_1', 'github', 'http://127.0.0.1:1/connections/callback'))
      .rejects.toMatchObject({ status: 400, message: 'Toolkit "github" is not allowed by policy.' });
    expect(fixture.fetch).not.toHaveBeenCalled();

    await fixture.service.executeTool('user_1', 'SLACK_SEARCH_MESSAGES', { query: 'allowed' });
    expect(fixture.client.create).toHaveBeenCalledWith('user_1', {
      toolkits: ['slack'],
      manageConnections: false,
    });
  });

  test('blocks schemas and execution belonging to a denied toolkit', async () => {
    const fixture = createFixture({ allowedToolkits: 'slack', log: vi.fn() });
    vi.mocked(fixture.client.tools.getRawComposioToolBySlug).mockResolvedValue({
      ...slackSearchTool,
      slug: 'GITHUB_CREATE_ISSUE',
      toolkit: { slug: 'github', name: 'GitHub' },
    });
    await expect(fixture.service.getToolSchemas('user_1', ['GITHUB_CREATE_ISSUE']))
      .rejects.toMatchObject({ status: 400 });
    await expect(fixture.service.executeTool('user_1', 'GITHUB_CREATE_ISSUE', { query: 'x' }))
      .rejects.toMatchObject({ status: 400 });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test('fails closed when Tool Router scope and the allowlist do not overlap', async () => {
    const fixture = createFixture({
      allowedToolkits: 'slack',
      toolRouterToolkits: 'github',
      log: vi.fn(),
    });
    vi.mocked(fixture.client.tools.getRawComposioToolBySlug)
      .mockRejectedValue(new Error('invalid_type at outputParameters'));
    await expect(fixture.service.executeTool('user_1', 'UNKNOWN_TOOL', {}))
      .rejects.toMatchObject({
        status: 503,
        message: 'Composio Tool Router has no toolkits allowed by policy.',
      });
    expect(fixture.client.create).not.toHaveBeenCalled();
  });
});

describe('ComposioService connection ownership', () => {
  test('retrieves a same-user pending request after paginating the ownership list', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockImplementation(async ({ cursor }) => cursor
      ? {
        items: [{ id: 'req_owned', toolkit: { slug: 'slack' }, status: 'INITIATED' }],
        nextCursor: null,
      }
      : {
        items: [{ id: 'req_older', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }],
        nextCursor: 'page_2',
      });
    vi.mocked(fixture.client.connectedAccounts.get).mockResolvedValue({
      id: 'req_owned',
      toolkit: { slug: 'slack' },
      status: 'INITIATED',
    });

    await expect(fixture.service.getRequest(' user_1 ', ' req_owned ')).resolves.toEqual({
      id: 'req_owned',
      toolkitSlug: 'slack',
      toolkitName: 'Slack',
      logoUrl: null,
      status: 'pending',
      redirectUrl: null,
      connectedAccountId: null,
      errorMessage: null,
    });
    expect(fixture.client.connectedAccounts.list).toHaveBeenNthCalledWith(1, {
      userIds: ['user_1'],
      limit: 100,
    });
    expect(fixture.client.connectedAccounts.list).toHaveBeenNthCalledWith(2, {
      userIds: ['user_1'],
      limit: 100,
      cursor: 'page_2',
    });
    expect(fixture.client.connectedAccounts.get).toHaveBeenCalledWith('req_owned');
  });

  test('returns the same 404 for a foreign request without retrieving its details', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockResolvedValue({
      items: [{ id: 'req_owned', toolkit: { slug: 'slack' }, status: 'INITIATED' }],
      nextCursor: null,
    });
    await expect(fixture.service.getRequest('user_1', 'req_foreign'))
      .rejects.toMatchObject({
        status: 404,
        message: 'Connection request "req_foreign" not found.',
      });
    expect(fixture.client.connectedAccounts.get).not.toHaveBeenCalled();
  });

  test('verifies ownership, disables, and deletes the connected account', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockResolvedValue({
      items: [{ id: 'ca_123', toolkit: { slug: 'slack' } }],
    });
    await expect(fixture.service.deleteConnection(' user_1 ', ' ca_123 ')).resolves.toBeUndefined();
    expect(fixture.client.connectedAccounts.list).toHaveBeenCalledWith({
      userIds: ['user_1'],
      statuses: ['ACTIVE', 'INACTIVE'],
      limit: 100,
    });
    expect(fixture.client.connectedAccounts.disable).toHaveBeenCalledWith('ca_123');
    expect(fixture.client.connectedAccounts.delete).toHaveBeenCalledWith('ca_123');
  });

  test('does not mutate an account that is not owned by the authenticated user', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockResolvedValue({
      items: [{ id: 'ca_other', toolkit: { slug: 'slack' } }],
    });
    await expect(fixture.service.deleteConnection('user_1', 'ca_123'))
      .rejects.toMatchObject({ status: 404 });
    expect(fixture.client.connectedAccounts.disable).not.toHaveBeenCalled();
    expect(fixture.client.connectedAccounts.delete).not.toHaveBeenCalled();
  });

  test('continues with token revocation when the best-effort disable fails', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockResolvedValue({
      items: [{ id: 'ca_123', toolkit: { slug: 'slack' } }],
    });
    vi.mocked(fixture.client.connectedAccounts.disable).mockRejectedValue(new Error('already disabled'));
    await fixture.service.deleteConnection('user_1', 'ca_123');
    expect(fixture.client.connectedAccounts.delete).toHaveBeenCalledWith('ca_123');
  });

  test('filters disabled rows while Composio soft deletion converges', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockResolvedValue({
      items: [
        { id: 'ca_deleted', toolkit: { slug: 'github' }, status: 'ACTIVE', isDisabled: true },
        { id: 'ca_live', toolkit: { slug: 'slack' }, status: 'ACTIVE', isDisabled: false },
      ],
    });
    await expect(fixture.service.listConnections('user_1')).resolves.toEqual([
      expect.objectContaining({ connectedAccountId: 'ca_live', toolkitSlug: 'slack' }),
    ]);
  });

  test('lists active connections across every account page', async () => {
    const fixture = createFixture();
    vi.mocked(fixture.client.connectedAccounts.list).mockImplementation(async ({ cursor }) => cursor
      ? {
        items: [{ id: 'ca_slack', toolkit: { slug: 'slack' }, status: 'ACTIVE' }],
        nextCursor: null,
      }
      : {
        items: [{ id: 'ca_github', toolkit: { slug: 'github' }, status: 'ACTIVE' }],
        nextCursor: 'page_2',
      });

    await expect(fixture.service.listConnections('user_1')).resolves.toEqual([
      expect.objectContaining({ connectedAccountId: 'ca_github', toolkitSlug: 'github' }),
      expect.objectContaining({ connectedAccountId: 'ca_slack', toolkitSlug: 'slack' }),
    ]);
    expect(fixture.client.connectedAccounts.list).toHaveBeenNthCalledWith(2, {
      userIds: ['user_1'],
      statuses: ['ACTIVE', 'INACTIVE'],
      limit: 100,
      cursor: 'page_2',
    });
  });
});

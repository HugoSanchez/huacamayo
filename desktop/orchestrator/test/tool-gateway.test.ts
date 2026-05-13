import { describe, expect, it, vi } from 'vitest';
import { ToolGatewayHttpError, ToolGatewayService } from '../src/integrations/tool-gateway.ts';
import type { ComposioBridgeService } from '../src/integrations/composio-bridge.ts';

describe('ToolGatewayService', () => {
  it('uses opaque action ids and sanitizes arguments before execution', async () => {
    const bridge = {
      configured: true,
      findActions: vi.fn(async () => [
        {
          provider: 'composio' as const,
          providerAction: 'SLACK_SEARCH_MESSAGES',
          appSlug: 'slack',
          appName: 'Slack',
          name: 'Search Slack messages',
          description: null,
          inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string' },
              count: { type: 'integer', minimum: 1, maximum: 50 },
              cursor: { type: 'string' },
              page: { type: 'integer' },
            },
          },
          guidance: null,
          connection: null,
        },
      ]),
      executeAction: vi.fn(async (_providerAction: string, _args: Record<string, unknown>) => ({
        provider: 'composio' as const,
        providerAction: 'SLACK_SEARCH_MESSAGES',
        data: { ok: true },
        error: null,
        logId: 'log_1',
        successful: true,
      })),
    } as unknown as ComposioBridgeService;
    const gateway = new ToolGatewayService(bridge);

    const actions = await gateway.findActions({ app: 'slack', intent: 'search Slack' });
    expect(actions[0].actionId).toMatch(/^act_/);
    expect(actions[0].actionId).not.toContain('SLACK_SEARCH_MESSAGES');

    const result = await gateway.executeAction(actions[0].actionId, {
      query: 'Katana',
      count: '100',
      cursor: '',
      page: 1,
      unknown: 'drop me',
    });

    expect(bridge.executeAction).toHaveBeenCalledWith('SLACK_SEARCH_MESSAGES', {
      query: 'Katana',
      count: 50,
      page: 1,
    });
    expect(result.warnings).toContain('Dropped unknown argument "unknown".');
    expect(result.warnings).toContain('Dropped empty cursor.');
    expect(result.warnings).toContain('Clamped "count" to schema maximum 50.');
  });

  it('rejects execution when required schema arguments are missing', async () => {
    const bridge = {
      configured: true,
      findActions: vi.fn(async () => [
        {
          provider: 'composio' as const,
          providerAction: 'GMAIL_FETCH_EMAILS',
          appSlug: 'gmail',
          appName: 'Gmail',
          name: 'Fetch emails',
          description: null,
          inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string' },
            },
          },
          guidance: null,
          connection: null,
        },
      ]),
      executeAction: vi.fn(),
    } as unknown as ComposioBridgeService;
    const gateway = new ToolGatewayService(bridge);
    const [action] = await gateway.findActions({ app: 'gmail', intent: 'fetch emails' });

    await expect(gateway.executeAction(action.actionId, {})).rejects.toThrow(ToolGatewayHttpError);
    expect(bridge.executeAction).not.toHaveBeenCalled();
  });
});

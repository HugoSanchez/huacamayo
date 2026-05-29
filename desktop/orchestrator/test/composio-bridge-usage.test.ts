import { describe, expect, test } from 'vitest';
import { buildComposioToolUsageInput } from '../src/integrations/composio-bridge.ts';

describe('buildComposioToolUsageInput', () => {
  test('uses complete schema metadata when available', () => {
    const usage = buildComposioToolUsageInput(
      'SLACK_SEARCH_MESSAGES',
      {
        slug: 'SLACK_SEARCH_MESSAGES',
        name: 'Search messages',
        description: 'Search Slack messages.',
        toolkitSlug: 'slack',
        toolkitName: 'Slack',
        inputParameters: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string' } },
        },
      },
      null,
      ['slack'],
    );

    expect(usage).toMatchObject({
      slug: 'SLACK_SEARCH_MESSAGES',
      name: 'Search messages',
      description: 'Search Slack messages.',
      toolkitSlug: 'slack',
      toolkitName: 'Slack',
      inputParameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
    });
  });

  test('recovers malformed schemas from cached search metadata', () => {
    const usage = buildComposioToolUsageInput(
      'GRANOLA_MCP_QUERY_GRANOLA_MEETINGS',
      {
        slug: 'GRANOLA_MCP_QUERY_GRANOLA_MEETINGS',
        name: 'GRANOLA_MCP_QUERY_GRANOLA_MEETINGS',
        description: 'Schema unavailable from Composio (malformed upstream). Call the tool with best-guess arguments.',
        toolkitSlug: null,
        toolkitName: null,
        inputParameters: null,
      },
      {
        slug: 'GRANOLA_MCP_QUERY_GRANOLA_MEETINGS',
        name: 'Query granola meetings',
        description: 'Query Granola about the user meetings using natural language.',
        toolkitSlug: 'granola_mcp',
        toolkitName: 'GRANOLA_MCP',
      },
      ['granola_mcp'],
    );

    expect(usage).toMatchObject({
      slug: 'GRANOLA_MCP_QUERY_GRANOLA_MEETINGS',
      name: 'Query granola meetings',
      description: 'Query Granola about the user meetings using natural language.',
      toolkitSlug: 'granola_mcp',
      toolkitName: 'GRANOLA_MCP',
      inputParameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    });
  });

  test('infers connected toolkit from slug prefix when schema metadata is missing', () => {
    const usage = buildComposioToolUsageInput(
      'GRANOLA_MCP_LIST_MEETINGS',
      {
        slug: 'GRANOLA_MCP_LIST_MEETINGS',
        name: 'GRANOLA_MCP_LIST_MEETINGS',
        description: null,
        toolkitSlug: null,
        toolkitName: null,
        inputParameters: null,
      },
      null,
      ['gmail', 'granola_mcp'],
    );

    expect(usage).toMatchObject({
      slug: 'GRANOLA_MCP_LIST_MEETINGS',
      toolkitSlug: 'granola_mcp',
      inputParameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    });
  });

  test('skips malformed tools when toolkit cannot be identified', () => {
    const usage = buildComposioToolUsageInput(
      'UNKNOWN_TOOL',
      {
        slug: 'UNKNOWN_TOOL',
        name: 'UNKNOWN_TOOL',
        description: null,
        toolkitSlug: null,
        toolkitName: null,
        inputParameters: null,
      },
      null,
      ['gmail'],
    );

    expect(usage).toBeNull();
  });
});

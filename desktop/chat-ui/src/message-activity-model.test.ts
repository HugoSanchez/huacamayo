import { describe, expect, it } from 'vitest';
import type { ActivityStep } from './types';
import {
  activityStepsWithReasoningFallback,
  formatElapsed,
  friendlyToolName,
  iconForTool,
  normalizeThinking,
  parseComposioExecute,
  parseCronToolStep,
  previewInput,
  stripNamespace,
  unwrapToolCall,
  type ToolkitInfo,
} from './message-activity-model';

const toolkits = new Map<string, ToolkitInfo>([
  ['slack', { name: 'Slack', logoUrl: '/logos/slack.png', connected: true }],
  ['granola-mcp', { name: 'Granola', logoUrl: null, connected: true }],
  ['gmail', { name: 'Gmail', logoUrl: null, connected: false }],
]);

describe('activityStepsWithReasoningFallback', () => {
  it('prepends legacy reasoning when the ordered stream has none', () => {
    const steps: ActivityStep[] = [{ type: 'text', text: 'Working' }];
    expect(activityStepsWithReasoningFallback(steps, '  Plan  ')).toEqual([
      { type: 'reasoning', text: 'Plan' },
      ...steps,
    ]);
  });

  it('does not duplicate ordered reasoning', () => {
    const steps: ActivityStep[] = [{ type: 'reasoning', text: 'Already here' }];
    expect(activityStepsWithReasoningFallback(steps, 'Legacy')).toBe(steps);
  });
});

describe('reasoning and timing presentation', () => {
  it('repairs adjacent bold reasoning headings', () => {
    expect(normalizeThinking(' **First****Second** ')).toBe('**First**\n\n**Second**');
  });

  it('formats sub-minute and longer durations', () => {
    expect(formatElapsed(12_340)).toBe('12.3s');
    expect(formatElapsed(62_340)).toBe('1m 2.3s');
  });
});

describe('parseCronToolStep', () => {
  it('uses the confirmed job returned by a successful mutation', () => {
    expect(parseCronToolStep({
      type: 'tool',
      name: 'cronjob',
      input: { action: 'create', name: 'Fallback', schedule: 'daily' },
      result: JSON.stringify({
        success: true,
        job: { id: 'job-1', name: 'Morning brief', schedule_display: 'Every day at 09:00' },
      }),
    })).toEqual({
      action: 'create',
      jobId: 'job-1',
      name: 'Morning brief',
      scheduleDisplay: 'Every day at 09:00',
    });
  });

  it('retains the input id for a successful removal', () => {
    expect(parseCronToolStep({
      type: 'tool',
      name: 'cronjob',
      input: { action: 'remove', job_id: 'job-2' },
      result: '{"success":true}',
    })?.jobId).toBe('job-2');
  });

  it.each([
    undefined,
    'not json',
    '{"success":false}',
    '{"success":true}',
  ])('rejects incomplete or unsuccessful results: %s', (result) => {
    expect(parseCronToolStep({
      type: 'tool',
      name: 'cronjob',
      input: { action: result === '{"success":true}' ? 'unknown' : 'create' },
      result,
    })).toBeNull();
  });
});

describe('tool normalization', () => {
  it('unwraps the generic tool_call envelope without losing result metadata', () => {
    expect(unwrapToolCall({
      type: 'tool',
      id: 'call-1',
      name: 'tool_call',
      input: { name: 'mcp_verso_slack_list_messages', arguments: { channel: 'C1' } },
      result: 'ok',
    })).toEqual({
      type: 'tool',
      id: 'call-1',
      name: 'mcp_verso_slack_list_messages',
      input: { channel: 'C1' },
      result: 'ok',
    });
  });

  it('recognizes explicit and native Composio tool shapes', () => {
    expect(parseComposioExecute({
      type: 'tool',
      name: 'execute_composio_tool',
      input: { tool_slug: 'GRANOLA_MCP_LIST_MEETINGS' },
    }, toolkits)).toEqual({ toolkitName: 'Granola', logoUrl: null, actionLabel: 'list meetings' });

    expect(parseComposioExecute({
      type: 'tool',
      name: 'mcp_verso_slack_list_unread_messages',
    }, toolkits)).toEqual({
      toolkitName: 'Slack',
      logoUrl: '/logos/slack.png',
      actionLabel: 'list unread messages',
    });
  });

  it('does not decorate native tools for disconnected toolkits', () => {
    expect(parseComposioExecute({
      type: 'tool',
      name: 'mcp_verso_gmail_send_email',
    }, toolkits)).toBeNull();
  });

  it('keeps namespace removal, labels, icons, and input previews deterministic', () => {
    expect(stripNamespace('mcp__verso__search_files')).toBe('search_files');
    expect(friendlyToolName('mcp_verso_update_calendar_event')).toBe('Update calendar event');
    expect(iconForTool('mcp_verso_delete_message')).toBe('trash');
    expect(iconForTool('unknown_operation')).toBe('dot');
    expect(previewInput({ ignored: 4, query: 'needle' })).toBe('needle');
    expect(previewInput(['one', 'two'])).toBe('2 items');
  });
});

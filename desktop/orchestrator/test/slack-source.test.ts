import { describe, expect, it } from 'vitest';
import { SlackSource, parseSlackCursor } from '../src/http/slack-source.ts';
import type { IngestionBridge } from '../src/http/ingestion-source.ts';

interface Call { slug: string; args: Record<string, unknown>; opts?: { recordUsage?: boolean }; }

const histResp = (messages: unknown[], nextCursor?: string) =>
  ({ data: { messages, ...(nextCursor ? { response_metadata: { next_cursor: nextCursor } } : {}) }, error: null as string | null, logId: null });
const listResp = (channels: unknown[], nextCursor?: string) =>
  ({ data: { channels, ...(nextCursor ? { response_metadata: { next_cursor: nextCursor } } : {}) }, error: null as string | null, logId: null });
const errResp = (message: string) => ({ data: null, error: message, logId: null });
const msg = (ts: string, text: string, over: Record<string, unknown> = {}) => ({ type: 'message', ts, user: 'U1', text, ...over });
const chan = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, ...over });

function bridgeWith(handlers: { history?: (args: Record<string, unknown>) => ReturnType<typeof histResp>; list?: (args: Record<string, unknown>) => ReturnType<typeof listResp> }) {
  const calls: Call[] = [];
  const bridge: IngestionBridge = {
    async executeTool(slug, args, opts) {
      calls.push({ slug, args, opts });
      if (slug === 'SLACK_FETCH_CONVERSATION_HISTORY') return handlers.history ? handlers.history(args) : histResp([]);
      if (slug === 'SLACK_LIST_CONVERSATIONS') return handlers.list ? handlers.list(args) : listResp([]);
      return errResp('unknown');
    },
  };
  return { bridge, calls };
}

const seed = (w: string) => JSON.stringify({ w, p: null, max: w });

describe('SlackSource.fetchSince', () => {
  it('fetches history into messages, sorted ascending, with oldest + recordUsage:false', async () => {
    const { bridge, calls } = bridgeWith({ history: () => histResp([msg('200.000100', 'hello'), msg('100.000100', 'hi')]) });
    const result = await new SlackSource(bridge).fetchSince('C1', seed('50.0'), { maxItems: 50 });

    expect(result.items.map((i) => i.sourceRef)).toEqual(['100.000100', '200.000100']);
    expect(result.items[0].content).toBe('U1: hi');
    expect(calls[0].args).toMatchObject({ channel: 'C1', oldest: '50.0', limit: 50 });
    expect(calls[0].opts).toEqual({ recordUsage: false });
    const cur = parseSlackCursor(result.nextCursor);
    expect(cur).toMatchObject({ w: '200.000100', p: null }); // advanced to newest, no token
    expect(result.hasMore).toBe(false);
  });

  it('holds the watermark and carries the page cursor while more history remains', async () => {
    const { bridge } = bridgeWith({ history: () => histResp([msg('300.1', 'newest')], 'PGTOK') });
    const result = await new SlackSource(bridge).fetchSince('C1', seed('50.0'), { maxItems: 50 });
    expect(result.hasMore).toBe(true);
    expect(parseSlackCursor(result.nextCursor)).toMatchObject({ w: '50.0', p: 'PGTOK', max: '300.1' });
  });

  it('continues a drain using the carried cursor against the same oldest', async () => {
    const { bridge, calls } = bridgeWith({ history: () => histResp([msg('40.0', 'older')]) });
    await new SlackSource(bridge).fetchSince('C1', JSON.stringify({ w: '50.0', p: 'PGTOK', max: '300.1' }), { maxItems: 50 });
    expect(calls[0].args).toMatchObject({ channel: 'C1', oldest: '50.0', cursor: 'PGTOK' });
  });

  it('skips system messages (subtype), non-message types, and empty/idless messages', async () => {
    const { bridge } = bridgeWith({
      history: () => histResp([
        msg('1.1', 'real'),
        msg('2.1', 'joined', { subtype: 'channel_join' }),
        msg('3.1', ''),
        { type: 'reaction_added', ts: '4.1', text: 'x', user: 'U9' },
        { type: 'message', text: 'no ts', user: 'U9' },
      ]),
    });
    const result = await new SlackSource(bridge).fetchSince('C1', seed('0'), { maxItems: 50 });
    expect(result.items.map((i) => i.sourceRef)).toEqual(['1.1']);
  });

  it('throws on a provider error', async () => {
    const { bridge } = bridgeWith({ history: () => errResp('not_in_channel') });
    await expect(new SlackSource(bridge).fetchSince('C1', seed('0'), { maxItems: 50 })).rejects.toThrow(/not_in_channel/);
  });

  it('regression: a page of only skipped messages still advances the cursor (no stall)', async () => {
    const { bridge } = bridgeWith({
      history: () => histResp([
        msg('500.000100', 'joined', { subtype: 'channel_join' }),
        msg('600.000100', 'beep', { subtype: 'bot_message' }),
        { type: 'reaction_added', ts: '700.000100', user: 'U9' },
      ]),
    });
    const result = await new SlackSource(bridge).fetchSince('C1', seed('100.0'), { maxItems: 50 });
    expect(result.items).toEqual([]); // nothing ingested...
    expect(parseSlackCursor(result.nextCursor).w).toBe('700.000100'); // ...but the watermark moved past them
    expect(result.hasMore).toBe(false);
  });

  it('seeds the cursor at now - lookback as a Slack ts', () => {
    const now = new Date('2026-06-17T10:00:00.000Z');
    const cur = parseSlackCursor(new SlackSource(bridgeWith({}).bridge).seedCursor(now, 7 * 24 * 60 * 60 * 1000));
    expect(cur.w).toBe(`${Math.floor((now.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000)}.000000`);
    expect(cur.p).toBeNull();
  });
});

describe('SlackSource.listConversations', () => {
  it('paginates and classifies channels vs DMs, recordUsage:false', async () => {
    const { bridge, calls } = bridgeWith({
      list: (args) => (args.cursor === 'PG2'
        ? listResp([chan('D9', '', { is_im: true })])
        : listResp([chan('C1', 'general'), chan('G2', 'private-chat', { is_private: true }), chan('C3', 'ext-partner', { is_ext_shared: true })], 'PG2')),
    });
    const result = await new SlackSource(bridge).listConversations('public_channel,private_channel,im');
    expect(result.map((c) => c.id)).toEqual(['C1', 'G2', 'C3', 'D9']);
    expect(result[1]).toMatchObject({ id: 'G2', isPrivate: true, isExternal: false });
    expect(result[2]).toMatchObject({ id: 'C3', isExternal: true });
    expect(result.find((c) => c.id === 'D9')).toMatchObject({ isIm: true });
    expect(calls.every((c) => c.opts?.recordUsage === false)).toBe(true);
    expect(calls).toHaveLength(2); // followed the next_cursor
  });

  it('throws on a provider error', async () => {
    const { bridge } = bridgeWith({ list: () => errResp('missing_scope') });
    await expect(new SlackSource(bridge).listConversations('public_channel')).rejects.toThrow(/missing_scope/);
  });
});

describe('parseSlackCursor', () => {
  it('parses JSON and bare watermark forms', () => {
    expect(parseSlackCursor(JSON.stringify({ w: '5.0', p: 'tok', max: '9.0' }))).toEqual({ w: '5.0', p: 'tok', max: '9.0' });
    expect(parseSlackCursor('5.0')).toEqual({ w: '5.0', p: null, max: '5.0' });
    expect(parseSlackCursor('')).toEqual({ w: '0', p: null, max: '0' });
  });
});

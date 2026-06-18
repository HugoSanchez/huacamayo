import {
  asString,
  type IngestionBridge,
  type IngestionFetchResult,
  type IngestionItem,
  type SourceAdapter,
} from './ingestion-source.ts';

const SLACK_FETCH_HISTORY = 'SLACK_FETCH_CONVERSATION_HISTORY';
const SLACK_LIST_CONVERSATIONS = 'SLACK_LIST_CONVERSATIONS';
const DEFAULT_CONTENT_LIMIT = 8000;
const MAX_LIST_PAGES = 25;

export interface SlackConversation {
  id: string;
  name: string;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
}

// Slack's conversations.history is newest-first with an `oldest` filter and a
// cursor, exactly like Gmail — so the cursor carries a watermark `w` (the Slack
// ts we've fully synced to), an in-progress page cursor `p`, and the max ts seen
// during the drain. The watermark advances only when the page cursor is
// exhausted, so older messages behind the cursor are never skipped.
export interface SlackCursor {
  w: string;
  p: string | null;
  max: string;
}

export function parseSlackCursor(cursor: string): SlackCursor {
  try {
    const parsed = JSON.parse(cursor) as Partial<SlackCursor>;
    if (parsed && typeof parsed === 'object' && typeof parsed.w === 'string') {
      return {
        w: parsed.w,
        p: typeof parsed.p === 'string' && parsed.p ? parsed.p : null,
        max: typeof parsed.max === 'string' ? parsed.max : parsed.w,
      };
    }
  } catch {
    // Fall through: a bare string is treated as a watermark ts.
  }
  const w = cursor || '0';
  return { w, p: null, max: w };
}

/** A message's ts if it is a valid numeric Slack timestamp, else ''. */
function messageTs(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const ts = asString((raw as Record<string, unknown>).ts);
  return ts && Number.isFinite(Number(ts)) ? ts : '';
}

export class SlackSource implements SourceAdapter {
  readonly source = 'slack';
  readonly displayName = 'Slack';
  readonly defaultStream = '';
  readonly multiStream = true;

  constructor(
    private readonly bridge: IngestionBridge,
    private readonly contentLimit = DEFAULT_CONTENT_LIMIT,
  ) {}

  seedCursor(now: Date, lookbackMs: number): string {
    const seconds = Math.max(0, Math.floor((now.getTime() - lookbackMs) / 1000));
    const w = `${seconds}.000000`;
    return JSON.stringify({ w, p: null, max: w } satisfies SlackCursor);
  }

  async fetchSince(stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    const cur = parseSlackCursor(cursor);
    const res = await this.bridge.executeTool(
      SLACK_FETCH_HISTORY,
      { channel: stream, oldest: cur.w, limit: opts.maxItems, ...(cur.p ? { cursor: cur.p } : {}) },
      { recordUsage: false },
    );
    if (res.error) {
      throw new Error(`SLACK_FETCH_CONVERSATION_HISTORY failed: ${res.error}`);
    }

    const data = (res.data ?? {}) as { messages?: unknown; response_metadata?: { next_cursor?: unknown } };
    const rawMessages = Array.isArray(data.messages) ? data.messages : [];

    const items: IngestionItem[] = [];
    let pageMax = cur.max;
    for (const raw of rawMessages) {
      // Advance the watermark past EVERY message with a valid ts — including
      // skipped system/bot/empty messages — not just the ones we ingest.
      // Otherwise a page of only-skipped messages leaves the cursor unmoved and
      // the scheduler refetches those same messages forever.
      const ts = messageTs(raw);
      if (ts && Number(ts) > Number(pageMax)) pageMax = ts;
      const item = this.toItem(raw);
      if (item) items.push(item);
    }
    items.sort((a, b) => a.cursorValue - b.cursorValue);
    const nextPageToken = typeof data.response_metadata?.next_cursor === 'string' && data.response_metadata.next_cursor
      ? data.response_metadata.next_cursor
      : null;

    let nextCursor: SlackCursor;
    let hasMore: boolean;
    if (nextPageToken) {
      nextCursor = { w: cur.w, p: nextPageToken, max: pageMax };
      hasMore = true;
    } else {
      nextCursor = { w: pageMax, p: null, max: pageMax };
      hasMore = false;
    }

    return { items, nextCursor: JSON.stringify(nextCursor), hasMore };
  }

  private toItem(raw: unknown): IngestionItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const m = raw as Record<string, unknown>;

    const type = asString(m.type);
    if (type && type !== 'message') return null;
    if (m.subtype) return null; // skip join/leave/bot/system messages
    const ts = asString(m.ts);
    if (!ts) return null;
    const text = asString(m.text);
    if (!text) return null;

    const tsNum = Number(ts);
    const cursorValue = Number.isFinite(tsNum) ? tsNum : 0;
    const occurredAt = Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : '';
    const user = asString(m.user) || 'unknown';

    return { sourceRef: ts, cursorValue, occurredAt, content: `${user}: ${text}`.slice(0, this.contentLimit) };
  }

  /** Discovery for the picker / DM sync. `types` is e.g. 'public_channel,private_channel' or 'im,mpim'. */
  async listConversations(types: string): Promise<SlackConversation[]> {
    const out: SlackConversation[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const args: Record<string, unknown> = { types, limit: 200, exclude_archived: true };
      if (cursor) args.cursor = cursor;
      const res = await this.bridge.executeTool(SLACK_LIST_CONVERSATIONS, args, { recordUsage: false });
      if (res.error) {
        throw new Error(`SLACK_LIST_CONVERSATIONS failed: ${res.error}`);
      }
      const data = (res.data ?? {}) as { channels?: unknown; response_metadata?: { next_cursor?: unknown } };
      const channels = Array.isArray(data.channels) ? data.channels : [];
      for (const raw of channels) {
        if (!raw || typeof raw !== 'object') continue;
        const c = raw as Record<string, unknown>;
        const id = asString(c.id);
        if (!id) continue;
        out.push({
          id,
          name: asString(c.name),
          isPrivate: Boolean(c.is_private),
          isIm: Boolean(c.is_im),
          isMpim: Boolean(c.is_mpim),
        });
      }
      const next = asString(data.response_metadata?.next_cursor);
      if (!next) break;
      cursor = next;
    }
    return out;
  }
}

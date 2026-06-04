import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { draftIdForArgs } from '../src/integrations/composio-bridge.ts';
import { buildDraftsRoutes } from '../src/http/drafts.ts';
import { dispatch } from '../src/http/router.ts';
import { ChatStore, type ChatMessageRecord } from '../src/http/chat-store.ts';
import { applyDraftResolutions } from '../src/http/draft-resolutions.ts';

describe('Draft resolutions', () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempStore(): ChatStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-drafts-'));
    tempDirs.push(dir);
    return new ChatStore(path.join(dir, 'chat.sqlite'));
  }

  it('persists native draft resolutions by session and draft id', () => {
    const store = tempStore();
    const session = store.createSession('Drafts');

    const first = store.recordDraftResolution(session.id, ' draft_abc ', 'sent', ' Gmail ');
    expect(first).toMatchObject({
      sessionId: session.id,
      draftId: 'draft_abc',
      status: 'sent',
      channel: 'gmail',
    });

    store.recordDraftResolution(session.id, 'draft_abc', 'discarded', 'slack');
    expect(store.listDraftResolutions(session.id)).toHaveLength(1);
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      sessionId: session.id,
      draftId: 'draft_abc',
      status: 'discarded',
      channel: 'slack',
    });
  });

  it('annotates pending native draft tool steps with durable sent status', () => {
    const input = {
      channel: 'gmail',
      to: 'hugo@example.com',
      subject: 'Hello',
      body: 'Draft body',
    };
    const draftId = draftIdForArgs(input);
    const messages: ChatMessageRecord[] = [{
      id: 'm1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      steps: [{
        type: 'tool',
        id: 'call-1',
        name: 'mcp_verso_propose_message_draft',
        input,
        result: JSON.stringify({ data: { status: 'pending_review', channel: 'gmail' }, error: null }),
      }],
    }];

    const annotated = applyDraftResolutions(messages, [{
      sessionId: 'session-1',
      draftId,
      status: 'sent',
      channel: 'gmail',
      updatedAt: '2026-06-04T00:00:01.000Z',
    }]);
    const step = annotated[0].steps?.[0];
    expect(step?.type).toBe('tool');
    const result = JSON.parse(step?.type === 'tool' ? step.result ?? '{}' : '{}');
    expect(result.data.status).toBe('sent');
    expect(result.data.draft_id).toBe(draftId);
    expect(result.data.resolved_by).toBe('verso_native');
  });

  it('annotates pending native draft tool steps with durable discard status', () => {
    const input = { channel: 'slack', to: '#general', body: 'Draft body' };
    const draftId = draftIdForArgs(input);
    const messages: ChatMessageRecord[] = [{
      id: 'm1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-06-04T00:00:00.000Z',
      steps: [{
        type: 'tool',
        id: 'call-1',
        name: 'propose_message_draft',
        input,
        result: JSON.stringify({ data: { status: 'pending_review', channel: 'slack' }, error: null }),
      }],
    }];

    const annotated = applyDraftResolutions(messages, [{
      sessionId: 'session-1',
      draftId,
      status: 'discarded',
      channel: 'slack',
      updatedAt: '2026-06-04T00:00:01.000Z',
    }]);
    const step = annotated[0].steps?.[0];
    const result = JSON.parse(step?.type === 'tool' ? step.result ?? '{}' : '{}');
    expect(result.data.status).toBe('rejected');
    expect(result.data.reason).toBe('discarded_by_user');
  });

  it('records native sent drafts through the drafts API', async () => {
    const store = tempStore();
    const session = store.createSession('Drafts');
    const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
    const port = await startDraftServer(store, {
      executeTool: async (slug: string, args: Record<string, unknown>) => {
        calls.push({ slug, args });
        return { data: { ok: true }, error: null, logId: null };
      },
    });

    const input = { channel: 'gmail', to: 'hugo@example.com', subject: 'Hi', body: 'Hello' };
    const draftId = draftIdForArgs(input);
    const res = await fetch(`http://127.0.0.1:${port}/drafts/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, draftId, sessionId: session.id, wasEdited: false }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe('GMAIL_SEND_EMAIL');
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      draftId,
      status: 'sent',
      channel: 'gmail',
    });
  });

  it('records native discarded drafts through the drafts API', async () => {
    const store = tempStore();
    const session = store.createSession('Drafts');
    const input = { channel: 'slack', to: '#general', body: 'Hello' };
    const draftId = draftIdForArgs(input);
    const port = await startDraftServer(store, {
      executeTool: async () => ({ data: null, error: null, logId: null }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/drafts/${encodeURIComponent(draftId)}/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, channel: 'slack' }),
    });

    expect(res.status).toBe(200);
    expect(store.listDraftResolutions(session.id)[0]).toMatchObject({
      draftId,
      status: 'discarded',
      channel: 'slack',
    });
  });

  async function startDraftServer(
    store: ChatStore,
    bridge: { executeTool: (slug: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: string | null; logId: string | null }> },
  ): Promise<number> {
    const routes = buildDraftsRoutes(bridge as any, store);
    const server = http.createServer((req, res) => {
      dispatch(routes, req, res);
    });
    servers.push(server);

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
    });
  }
});

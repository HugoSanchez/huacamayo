import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/http/ingestion-store.ts';
import { SourceIngestionScheduler } from '../src/http/source-ingestion.ts';
import { SlackSource } from '../src/http/slack-source.ts';
import { SlackSelectionService } from '../src/http/slack-selection.ts';
import { buildSlackIngestionRoutes } from '../src/http/ingestion.ts';
import { dispatch } from '../src/http/router.ts';
import type { IngestionBridge } from '../src/http/ingestion-source.ts';

const fakeWorker = { ensureReady: async () => ({ baseUrl: 'http://test', apiKey: null }) };
const rawChan = (id: string, name: string, o: { isPrivate?: boolean; isIm?: boolean } = {}) =>
  ({ id, name, is_private: Boolean(o.isPrivate), is_im: Boolean(o.isIm) });

describe('Slack ingestion routes', () => {
  const tempDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function serve(opts: { channels?: unknown[]; dms?: unknown[]; listError?: string; dmListError?: string } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-slackroutes-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    const bridge: IngestionBridge = {
      async executeTool(slug, args) {
        if (slug === 'SLACK_LIST_CONVERSATIONS') {
          if (opts.listError) return { data: null, error: opts.listError, logId: null };
          const types = String((args as { types?: unknown }).types ?? '');
          if (types.includes('im') && opts.dmListError) return { data: null, error: opts.dmListError, logId: null };
          return { data: { channels: types.includes('im') ? (opts.dms ?? []) : (opts.channels ?? []) }, error: null, logId: null };
        }
        return { data: {}, error: null, logId: null };
      },
    };
    const slack = new SlackSource(bridge);
    const scheduler = new SourceIngestionScheduler(store, fakeWorker, [slack], { enabled: () => true });
    const service = new SlackSelectionService(slack, store, scheduler, 1e9);
    const server = http.createServer((req, res) => dispatch(buildSlackIngestionRoutes(service), req, res));
    servers.push(server);
    const port: number = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
    return { port, store };
  }

  const post = (port: number, url: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('GET /ingestion/slack/channels returns channels (no DMs) + dmsEnabled', async () => {
    const { port } = await serve({ channels: [rawChan('C1', 'general'), rawChan('D9', '', { isIm: true })] });
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/slack/channels`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dmsEnabled).toBe(false);
    expect(body.channels).toEqual([{ id: 'C1', name: 'general', isPrivate: false, enabled: false }]);
  });

  it('toggling a channel enables its stream', async () => {
    const { port, store } = await serve({ channels: [rawChan('C1', 'general')] });
    const res = await post(port, '/ingestion/slack/channels/C1/toggle', { enabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).channel).toEqual({ id: 'C1', enabled: true });
    expect(store.getSource('slack', 'C1')?.enabled).toBe(true);
  });

  it('toggling DMs on enables a stream per DM', async () => {
    const { port, store } = await serve({ dms: [rawChan('D1', '', { isIm: true })] });
    const res = await post(port, '/ingestion/slack/dms/toggle', { enabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).dmsEnabled).toBe(true);
    expect(store.getSource('slack', 'D1')?.enabled).toBe(true);
  });

  it('rejects an invalid channel id shape with 400', async () => {
    const { port, store } = await serve({ channels: [] });
    const res = await post(port, '/ingestion/slack/channels/not-a-real-id/toggle', { enabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_channel');
    expect(store.getSource('slack', 'not-a-real-id')).toBeNull(); // never enabled
  });

  it('a failed DM enable returns 502 and leaves DMs disabled', async () => {
    const { port, store } = await serve({ dmListError: 'rate_limited' });
    const res = await post(port, '/ingestion/slack/dms/toggle', { enabled: true });
    expect(res.status).toBe(502);
    expect(store.getConfig('slack.dmsEnabled')).toBe('false'); // rolled back, not left on
  });

  it('surfaces a Slack list error as 502', async () => {
    const { port } = await serve({ listError: 'missing_scope' });
    const res = await fetch(`http://127.0.0.1:${port}/ingestion/slack/channels`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('slack_error');
  });
});

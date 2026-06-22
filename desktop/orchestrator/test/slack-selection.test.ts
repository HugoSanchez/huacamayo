import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/http/ingestion-store.ts';
import { SourceIngestionScheduler } from '../src/http/source-ingestion.ts';
import { SlackSource } from '../src/http/slack-source.ts';
import { SlackSelectionService } from '../src/http/slack-selection.ts';
import type { IngestionBridge } from '../src/http/ingestion-source.ts';

const fakeWorker = { ensureReady: async () => ({ baseUrl: 'http://test', apiKey: null }) };
const rawChan = (id: string, name: string, o: { isPrivate?: boolean; isIm?: boolean; isMpim?: boolean } = {}) =>
  ({ id, name, is_private: Boolean(o.isPrivate), is_im: Boolean(o.isIm), is_mpim: Boolean(o.isMpim) });

describe('SlackSelectionService', () => {
  const tempDirs: string[] = [];
  afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function setup(initial: { channels?: unknown[]; dms?: unknown[]; listError?: string; dmListError?: string } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-slacksel-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    const channels = initial.channels ?? [];
    const dms = initial.dms ?? [];
    const bridge: IngestionBridge = {
      async executeTool(slug, args) {
        if (slug === 'SLACK_LIST_CONVERSATIONS') {
          if (initial.listError) return { data: null, error: initial.listError, logId: null };
          const types = String((args as { types?: unknown }).types ?? '');
          if (types.includes('im') && initial.dmListError) return { data: null, error: initial.dmListError, logId: null };
          return { data: { channels: types.includes('im') ? dms : channels }, error: null, logId: null };
        }
        return { data: {}, error: null, logId: null };
      },
    };
    const slack = new SlackSource(bridge);
    const scheduler = new SourceIngestionScheduler(store, fakeWorker, [slack], { enabled: () => true });
    const service = new SlackSelectionService(slack, store, scheduler, 1e9);
    return { store, service, channels, dms };
  }

  it('lists channels (excluding DMs) with enabled state from the store', async () => {
    const { service } = setup({ channels: [rawChan('C1', 'general'), rawChan('G2', 'priv', { isPrivate: true }), rawChan('D9', '', { isIm: true })] });
    service.setChannelEnabled('C1', true);
    const channels = await service.listChannels();
    expect(channels).toEqual([
      { id: 'C1', name: 'general', isPrivate: false, isExternal: false, enabled: true },
      { id: 'G2', name: 'priv', isPrivate: true, isExternal: false, enabled: false },
    ]);
  });

  it('enabling a channel seeds its cursor; disabling clears the flag', async () => {
    const { store, service } = setup();
    service.setChannelEnabled('C1', true);
    const row = store.getSource('slack', 'C1');
    expect(row?.enabled).toBe(true);
    expect(row?.cursor).toBeTruthy(); // seeded, not null
    service.setChannelEnabled('C1', false);
    expect(store.getSource('slack', 'C1')?.enabled).toBe(false);
  });

  it('DMs default off; enabling syncs every im/mpim into enabled streams', async () => {
    const { store, service } = setup({ dms: [rawChan('D1', '', { isIm: true }), rawChan('G3', '', { isMpim: true })] });
    expect(service.getDmsEnabled()).toBe(false);

    await service.setDmsEnabled(true);
    expect(service.getDmsEnabled()).toBe(true);
    expect(store.getSource('slack', 'D1')?.enabled).toBe(true);
    expect(store.getSource('slack', 'G3')?.enabled).toBe(true);
    expect(JSON.parse(store.getConfig('slack.dmStreams') ?? '[]').sort()).toEqual(['D1', 'G3']);
  });

  it('disabling DMs turns off all tracked DM streams', async () => {
    const { store, service } = setup({ dms: [rawChan('D1', '', { isIm: true })] });
    await service.setDmsEnabled(true);
    await service.setDmsEnabled(false);
    expect(service.getDmsEnabled()).toBe(false);
    expect(store.getSource('slack', 'D1')?.enabled).toBe(false);
    expect(JSON.parse(store.getConfig('slack.dmStreams') ?? '[]')).toEqual([]);
  });

  it('syncDms picks up newly-created DMs and is idempotent for existing ones', async () => {
    const { store, service, dms } = setup({ dms: [rawChan('D1', '', { isIm: true })] });
    await service.setDmsEnabled(true);
    dms.push(rawChan('D2', '', { isIm: true }));
    await service.syncDms();
    expect(store.getSource('slack', 'D2')?.enabled).toBe(true);
    expect(JSON.parse(store.getConfig('slack.dmStreams') ?? '[]').sort()).toEqual(['D1', 'D2']);
  });

  it('syncDms is a no-op while DMs are off', async () => {
    const { store, service } = setup({ dms: [rawChan('D1', '', { isIm: true })] });
    await service.syncDms();
    expect(store.getSource('slack', 'D1')).toBeNull();
  });

  it('rolls back dmsEnabled to false when the DM sync fails', async () => {
    const { store, service } = setup({ dmListError: 'rate_limited' });
    await expect(service.setDmsEnabled(true)).rejects.toThrow(/rate_limited/);
    expect(service.getDmsEnabled()).toBe(false); // not left flipped on
    expect(store.getConfig('slack.dmsEnabled')).toBe('false');
  });

  it('disableAll turns off every channel + DM and the DM flag', async () => {
    const { store, service } = setup({ channels: [rawChan('C1', 'general')], dms: [rawChan('D1', '', { isIm: true })] });
    service.setChannelEnabled('C1', true);
    await service.setDmsEnabled(true);
    service.disableAll();
    expect(store.getSource('slack', 'C1')?.enabled).toBe(false);
    expect(store.getSource('slack', 'D1')?.enabled).toBe(false);
    expect(service.getDmsEnabled()).toBe(false);
    expect(JSON.parse(store.getConfig('slack.dmStreams') ?? '[]')).toEqual([]);
  });

  it('propagates a Slack list error from listChannels', async () => {
    const { service } = setup({ listError: 'missing_scope' });
    await expect(service.listChannels()).rejects.toThrow(/missing_scope/);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionStore } from '../src/http/ingestion-store.ts';
import { SourceIngestionScheduler, isSourceIngestionEnabled, type IngestionRunner } from '../src/http/source-ingestion.ts';
import type { IngestionFetchResult, IngestionItem, SourceAdapter } from '../src/http/ingestion-source.ts';

const t0 = new Date('2026-06-17T10:00:00.000Z');
const MIN = 60 * 1000;
const at = (ms: number) => new Date(t0.getTime() + ms);
const item = (ref: string, ts: number): IngestionItem => ({
  sourceRef: ref,
  cursorValue: ts,
  occurredAt: new Date(ts).toISOString(),
  content: `content ${ref}`,
});

type Behavior = (cursor: string, call: number) => IngestionFetchResult;

class ScriptedAdapter implements SourceAdapter {
  readonly source = 'gmail';
  readonly displayName = 'Gmail';
  readonly defaultStream = '';
  readonly maxItemsPerBatch?: number;
  calls = 0;
  lastMaxItems = 0;
  constructor(private readonly behavior: Behavior, maxItemsPerBatch?: number) {
    this.maxItemsPerBatch = maxItemsPerBatch;
  }
  seedCursor(now: Date, lookbackMs: number): string {
    return String(now.getTime() - lookbackMs);
  }
  async fetchSince(_stream: string, cursor: string, opts: { maxItems: number }): Promise<IngestionFetchResult> {
    this.calls += 1;
    this.lastMaxItems = opts.maxItems;
    return this.behavior(cursor, this.calls);
  }
}

const fakeWorker = { ensureReady: async () => ({ baseUrl: 'http://test', apiKey: null }) };

describe('SourceIngestionScheduler', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: {
    behavior: Behavior;
    enabled?: () => boolean;
    extractionGate?: () => boolean;
    connectionGate?: (source: string) => boolean;
    detectThrows?: boolean;
    maxBatchAttempts?: number;
    baseBackoffMs?: number;
    adapterMaxItems?: number;
  }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'verso-sched-'));
    tempDirs.push(dir);
    const store = new IngestionStore(path.join(dir, 'ingestion.sqlite'));
    const adapter = new ScriptedAdapter(opts.behavior, opts.adapterMaxItems);
    const runs: Array<{ source: string; stream: string; items: Array<{ sourceRef: string }> }> = [];
    const runIngestion: IngestionRunner = async (_config, payload) => {
      runs.push(payload);
      if (opts.detectThrows) throw new Error('detect boom');
    };
    const scheduler = new SourceIngestionScheduler(store, fakeWorker, [adapter], {
      enabled: opts.enabled ?? (() => true),
      extractionGate: opts.extractionGate ?? (() => true),
      connectionGate: opts.connectionGate,
      runIngestion,
      maxBatchAttempts: opts.maxBatchAttempts ?? 5,
      baseBackoffMs: opts.baseBackoffMs ?? 1000,
    });
    return { store, adapter, runs, scheduler };
  }

  it('fetches, runs the detector with new items, and advances the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100), item('m2', 200)], nextCursor: '200', hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));

    expect(runs).toHaveLength(1);
    expect(runs[0].items.map((i) => i.sourceRef)).toEqual(['m1', 'm2']);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '200' });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString()); // 2h interval cadence
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('processed');
  });

  it('drains immediately while a page is full (hasMore)', async () => {
    const { store, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: true }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));
    expect(store.getSource('gmail', '')?.nextDueAt).toBe(at(MIN).toISOString()); // due now → drains next tick
  });

  it('skips already-processed items but still advances the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100), item('m2', 200)], nextCursor: '200', hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    store.markItemsProcessed('gmail', '', ['m1'], t0); // m1 already done

    await scheduler.tick(at(MIN));
    expect(runs[0].items.map((i) => i.sourceRef)).toEqual(['m2']); // only the new one
    expect(store.getSource('gmail', '')?.cursor).toBe('200');
  });

  it('does not call the detector on an empty page', async () => {
    const { store, runs, scheduler } = setup({
      behavior: (cursor) => ({ items: [], nextCursor: cursor, hasMore: false }),
    });
    store.enableSource('gmail', '', { seedCursor: '42' }, t0);

    await scheduler.tick(at(MIN));
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '42' });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString());
  });

  it('defers (no failure, no fetch) when the connection is inactive', async () => {
    const { store, adapter, runs, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: false }),
      connectionGate: () => false,
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    await scheduler.tick(at(MIN));
    expect(adapter.calls).toBe(0); // never fetched
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '0', failCount: 0 });
    expect(s.nextDueAt).toBe(at(MIN + 120 * MIN).toISOString());
  });

  it('backs off on a fetch error without advancing the cursor', async () => {
    const { store, runs, scheduler } = setup({
      behavior: () => { throw new Error('rate limited'); },
    });
    store.enableSource('gmail', '', { seedCursor: '7' }, t0);

    await scheduler.tick(at(MIN));
    expect(runs).toHaveLength(0);
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'failed', cursor: '7', failCount: 1 });
    expect(s.lastError).toMatch(/rate limited/);
  });

  it('poisons a repeatedly-failing page and skips past it instead of stalling', async () => {
    const { store, scheduler } = setup({
      behavior: () => ({ items: [item('m1', 100)], nextCursor: '100', hasMore: false }),
      detectThrows: true,
      maxBatchAttempts: 2,
      baseBackoffMs: 1000,
    });
    store.enableSource('gmail', '', { seedCursor: '0' }, t0);

    // Attempt 1: under threshold → fail, cursor held.
    await scheduler.tick(at(MIN));
    expect(store.getSource('gmail', '')).toMatchObject({ status: 'failed', cursor: '0', failCount: 1 });
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('pending');

    // Attempt 2 (after backoff): hits threshold → poison the page + advance cursor.
    await scheduler.tick(at(10 * MIN));
    expect(store.getItem('gmail', '', 'm1')?.status).toBe('poisoned');
    const s = store.getSource('gmail', '')!;
    expect(s).toMatchObject({ status: 'idle', cursor: '100' }); // skipped past the bad page
  });

  it('honors a per-adapter maxItemsPerBatch, else the scheduler default', async () => {
    const one = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), adapterMaxItems: 1 });
    one.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await one.scheduler.tick(at(MIN));
    expect(one.adapter.lastMaxItems).toBe(1);

    const def = setup({ behavior: () => ({ items: [], nextCursor: '0', hasMore: false }) });
    def.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await def.scheduler.tick(at(MIN));
    expect(def.adapter.lastMaxItems).toBe(20); // DEFAULT_MAX_ITEMS_PER_BATCH
  });

  it('source ingestion defaults on, with an explicit falsy env as kill switch', () => {
    const prev = process.env.VERSO_INGESTION_ENABLED;
    try {
      delete process.env.VERSO_INGESTION_ENABLED;
      expect(isSourceIngestionEnabled()).toBe(true); // toggle a source = enabled, no flag needed
      process.env.VERSO_INGESTION_ENABLED = '0';
      expect(isSourceIngestionEnabled()).toBe(false); // kill switch
      process.env.VERSO_INGESTION_ENABLED = 'yes';
      expect(isSourceIngestionEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VERSO_INGESTION_ENABLED;
      else process.env.VERSO_INGESTION_ENABLED = prev;
    }
  });

  it('does nothing when disabled or while the gate is closed', async () => {
    const disabled = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), enabled: () => false });
    disabled.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await disabled.scheduler.tick(at(MIN));
    expect(disabled.adapter.calls).toBe(0);

    const gated = setup({ behavior: () => ({ items: [item('m1', 1)], nextCursor: '1', hasMore: false }), extractionGate: () => false });
    gated.store.enableSource('gmail', '', { seedCursor: '0' }, t0);
    await gated.scheduler.tick(at(MIN));
    expect(gated.adapter.calls).toBe(0);
  });
});

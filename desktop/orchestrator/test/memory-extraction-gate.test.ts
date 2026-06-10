import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryExtractionScheduler } from '../src/http/memory-extraction.ts';
import type { ChatStore } from '../src/http/chat-store.ts';
import type { HermesSupervisor } from '../src/http/hermes-supervisor.ts';

/**
 * The extraction gate defers claiming while the local embedding runtime is
 * not ready: gbrain's put_page propagates embedding failures, so claiming a
 * session during the model-download window would burn the attempt instead of
 * just waiting. Deferred sessions stay pending and are claimed on a later
 * tick once the gate opens.
 */
describe('MemoryExtractionScheduler extraction gate', () => {
  let envSnapshot: string | undefined;

  beforeEach(() => {
    envSnapshot = process.env.VERSO_GBRAIN_ENABLED;
    process.env.VERSO_GBRAIN_ENABLED = '1';
  });

  afterEach(() => {
    if (envSnapshot === undefined) delete process.env.VERSO_GBRAIN_ENABLED;
    else process.env.VERSO_GBRAIN_ENABLED = envSnapshot;
  });

  function makeStore(): { store: ChatStore; claims: number } {
    const counter = { store: null as unknown as ChatStore, claims: 0 };
    counter.store = {
      claimDueMemoryExtraction: () => {
        counter.claims += 1;
        return null; // nothing due — we only care whether claiming was attempted
      },
    } as unknown as ChatStore;
    return counter;
  }

  it('does not claim while the gate is closed', async () => {
    const counter = makeStore();
    let gateOpen = false;
    const scheduler = new MemoryExtractionScheduler(
      counter.store,
      {} as HermesSupervisor,
      { extractionGate: () => gateOpen },
    );

    await scheduler.tick();
    expect(counter.claims).toBe(0);

    gateOpen = true;
    await scheduler.tick();
    expect(counter.claims).toBe(1);
  });

  it('claims by default when no gate is provided', async () => {
    const counter = makeStore();
    const scheduler = new MemoryExtractionScheduler(counter.store, {} as HermesSupervisor);

    await scheduler.tick();
    expect(counter.claims).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { GBrainExtractionQueue } from '../src/http/gbrain-extraction-queue.ts';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('GBrainExtractionQueue', () => {
  it('serializes runs — a second task does not start until the first finishes', async () => {
    const queue = new GBrainExtractionQueue();
    const events: string[] = [];
    const a = deferred();

    const pA = queue.run('chat', async () => {
      events.push('A:start');
      await a.promise;
      events.push('A:end');
    });
    const pB = queue.run('chat', async () => {
      events.push('B:start');
      events.push('B:end');
    });

    await tick();
    // A holds the lock; B must be queued, not running.
    expect(events).toEqual(['A:start']);
    expect(queue.isRunning).toBe(true);
    expect(queue.queueDepth).toBe(1);

    a.resolve();
    await Promise.all([pA, pB]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    expect(queue.isRunning).toBe(false);
  });

  it('prefers chat over source when both are waiting', async () => {
    const queue = new GBrainExtractionQueue();
    const order: string[] = [];
    const holder = deferred();

    const pHolder = queue.run('source', async () => {
      order.push('holder');
      await holder.promise;
    });
    await tick(); // holder now owns the lock

    // Enqueue a source FIRST, then a chat — chat must still run first.
    const pSource = queue.run('source', async () => { order.push('source'); });
    const pChat = queue.run('chat', async () => { order.push('chat'); });

    holder.resolve();
    await Promise.all([pHolder, pSource, pChat]);
    expect(order).toEqual(['holder', 'chat', 'source']);
  });

  it('is FIFO within the same priority', async () => {
    const queue = new GBrainExtractionQueue();
    const order: string[] = [];
    const holder = deferred();

    const pHolder = queue.run('chat', async () => { order.push('holder'); await holder.promise; });
    await tick();

    const p1 = queue.run('chat', async () => { order.push('chat1'); });
    const p2 = queue.run('chat', async () => { order.push('chat2'); });

    holder.resolve();
    await Promise.all([pHolder, p1, p2]);
    expect(order).toEqual(['holder', 'chat1', 'chat2']);
  });

  it('releases the lock even when a task throws', async () => {
    const queue = new GBrainExtractionQueue();
    await expect(queue.run('chat', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(queue.isRunning).toBe(false);

    let ran = false;
    await queue.run('source', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('does not let a long source drain starve interleaved chat work', async () => {
    const queue = new GBrainExtractionQueue();
    const order: string[] = [];
    const page1 = deferred();

    // A source "drain" holds the lock for its first page.
    const pPage1 = queue.run('source', async () => { order.push('source:page1'); await page1.promise; });
    await tick();

    // While page1 runs, a chat extraction and the source's next page both queue.
    const pChat = queue.run('chat', async () => { order.push('chat'); });
    const pPage2 = queue.run('source', async () => { order.push('source:page2'); });

    page1.resolve();
    await Promise.all([pPage1, pChat, pPage2]);
    // Chat is served before the next source page.
    expect(order).toEqual(['source:page1', 'chat', 'source:page2']);
  });
});

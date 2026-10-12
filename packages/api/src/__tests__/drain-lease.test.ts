import { describe, expect, it, vi } from 'vitest';

import { drainOutbox, type ClaimedRow, type OutboxStore } from '../events/drain-worker.js';

/**
 * Issue #424 — bounded send pool, cycle deadline and batch marking for
 * the leased drain.
 */

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function rows(n: number): ClaimedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    eventId: `evt-${String(i + 1)}`,
    eventType: 'reservation.created',
    payload: {},
    occurredAt: new Date('2026-10-12T00:00:00Z'),
    attempts: 1,
    studioId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }));
}

function leasedStore(claimed: ClaimedRow[]) {
  const markPublishedMany = vi.fn<NonNullable<OutboxStore['markPublishedMany']>>(async () => {});
  const release = vi.fn<NonNullable<OutboxStore['release']>>(async () => {});
  const markPublished = vi.fn<OutboxStore['markPublished']>(async () => {});
  const store: OutboxStore = {
    claimBatch: vi.fn(async () => claimed),
    markPublished,
    markPublishedMany,
    release,
  };
  return { store, markPublishedMany, release, markPublished };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('drainOutbox — leased store', () => {
  it('never runs more sends at once than the pool allows', async () => {
    let inFlight = 0;
    let peak = 0;
    const queue = {
      send: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await delay(5);
        inFlight -= 1;
      }),
    };
    const { store, markPublishedMany } = leasedStore(rows(40));

    const result = await drainOutbox({ store, queue, concurrency: 4, logger: silent });

    expect(result).toEqual({ processed: 40, succeeded: 40, failed: 0 });
    expect(peak).toBe(4);
    expect(markPublishedMany).toHaveBeenCalledTimes(1);
    expect(markPublishedMany.mock.calls[0]![0]).toHaveLength(40);
  });

  it('a pool cuts the cycle time of a slow queue (capacity model)', async () => {
    const queue = { send: async () => delay(20) };
    const startedAt = Date.now();
    await drainOutbox({
      store: leasedStore(rows(200)).store,
      queue,
      concurrency: 8,
      logger: silent,
    });
    // Sequential: 200 × 20 ms = 4 s. Pool of 8: ~25 waves × 20 ms.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('stops starting sends at the deadline and releases the rest', async () => {
    let now = 0;
    const clock = { now: () => new Date(now) };
    const queue = {
      send: vi.fn(async () => {
        now += 1_000;
      }),
    };
    const claimed = rows(10);
    const { store, release, markPublishedMany } = leasedStore(claimed);

    const result = await drainOutbox({
      store,
      queue,
      clock,
      deadlineMs: 3_000,
      logger: silent,
    });

    expect(queue.send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ processed: 10, succeeded: 3, failed: 7 });
    expect(markPublishedMany.mock.calls[0]![0]).toEqual(claimed.slice(0, 3).map((r) => r.id));
    expect(release).toHaveBeenCalledWith(claimed.slice(3).map((r) => r.id));
  });

  it('counts the batch as failed when the final stamp fails (lease lapses, rows retry)', async () => {
    const { store, markPublishedMany } = leasedStore(rows(3));
    markPublishedMany.mockRejectedValueOnce(new Error('db down'));

    const result = await drainOutbox({ store, queue: { send: async () => {} }, logger: silent });

    expect(result).toEqual({ processed: 3, succeeded: 0, failed: 3 });
  });

  it('does not stamp rows whose send failed', async () => {
    const claimed = rows(3);
    const { store, markPublishedMany } = leasedStore(claimed);
    const queue = {
      send: vi.fn(async (msg: unknown) => {
        if ((msg as { id: string }).id === 'evt-2') throw new Error('queue down');
      }),
    };

    const result = await drainOutbox({ store, queue, logger: silent });

    expect(result).toEqual({ processed: 3, succeeded: 2, failed: 1 });
    expect(markPublishedMany.mock.calls[0]![0]).toEqual([claimed[0]!.id, claimed[2]!.id]);
  });

  it('rejects a non-positive pool size', async () => {
    await expect(
      drainOutbox({
        store: leasedStore(rows(1)).store,
        queue: { send: async () => {} },
        concurrency: 0,
        logger: silent,
      }),
    ).rejects.toThrow(RangeError);
  });
});

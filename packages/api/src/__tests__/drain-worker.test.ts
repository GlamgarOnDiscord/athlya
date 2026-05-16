/**
 * Unit tests for the outbox drain worker.
 *
 * The module under test is pure (no DB, no queue SDK) so the suite
 * only needs `vi.fn()` doubles for the ports:
 *
 *   - `OutboxStore.claimBatch(size)` — returns the rows a given test
 *     wants to feed to the drain.
 *   - `OutboxStore.markPublished(id)` — `resolve` on success,
 *     `reject` on failure.
 *   - `QueueProducer.send(event)` — same pattern.
 *
 * The scenarios mirror the acceptance list in the task description:
 *
 *   1. Happy path: claims N rows, sends each, marks each published,
 *      returns the right counts AND the reconstructed envelope shape
 *      matches what `publish.ts` would put on the bus.
 *   2. Empty batch: no queue traffic, no mark-published calls,
 *      counts are `{ 0, 0, 0 }`.
 *   3. Send failure for one row: the failing row is NEVER marked
 *      published, the other rows still go through, counts reflect
 *      the failure.
 *   4. Mark-published failure: the queue send already succeeded, the
 *      mark fails, the drain logs an `error` and continues with the
 *      next row (no abort).
 *   5. Invalid batch size throws synchronously so mis-wiring surfaces
 *      early — covers the defensive `normaliseBatchSize` guard.
 *   6. `claimBatch` throwing propagates (infrastructural failure, not
 *      a per-row failure).
 *
 * Style note — the `vi.fn()` helpers are typed with explicit generics
 * so the tests inherit the port's argument / return types. Without
 * the explicit generics, mock implementations resolve to `any` and
 * eslint's `no-unsafe-return` rule fires on every `return` in an
 * `async` mock body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BATCH_SIZE,
  drainOutbox,
  type ClaimedRow,
  type Logger,
  type OutboxStore,
  type QueueProducer,
} from '../events/drain-worker.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Strongly-typed alias for the `claimBatch` mock. */
type ClaimBatchFn = (size: number) => Promise<readonly ClaimedRow[]>;
/** Strongly-typed alias for the `markPublished` / `send` mocks. */
type IdMutatorFn = (id: string) => Promise<void>;
type SendFn = (message: unknown) => Promise<void>;

/**
 * Build a claimed row with reasonable defaults. `overrides` lets a
 * test tweak any field (most often `id` / `eventId`) without
 * rewriting the whole literal.
 */
function row(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    eventId: '00000000-0000-4000-8000-00000000aaa1',
    eventType: 'reservation.created',
    payload: { hello: 'world' },
    occurredAt: new Date('2025-01-01T12:00:00.000Z'),
    attempts: 1,
    ...overrides,
  };
}

/**
 * Shape returned by {@link makeDoubles}. Exposing the raw `vi.fn()`
 * spies (not just the port interfaces) lets tests assert call counts
 * and argument shapes without reaching into private state.
 */
interface Doubles {
  readonly store: OutboxStore;
  readonly queue: QueueProducer;
  readonly logger: Logger;
  readonly claimBatch: ReturnType<typeof vi.fn<ClaimBatchFn>>;
  readonly markPublished: ReturnType<typeof vi.fn<IdMutatorFn>>;
  readonly send: ReturnType<typeof vi.fn<SendFn>>;
  readonly loggerInfo: ReturnType<typeof vi.fn>;
  readonly loggerWarn: ReturnType<typeof vi.fn>;
  readonly loggerError: ReturnType<typeof vi.fn>;
}

/**
 * Build a fresh set of doubles. Each spy is typed with the explicit
 * port signature, which means mock implementations and
 * `mockRejectedValueOnce` calls inherit the proper types without any
 * `as` cast.
 */
function makeDoubles(rows: readonly ClaimedRow[]): Doubles {
  const claimBatch = vi.fn<ClaimBatchFn>().mockResolvedValue(rows);
  const markPublished = vi.fn<IdMutatorFn>().mockResolvedValue(undefined);
  const send = vi.fn<SendFn>().mockResolvedValue(undefined);

  // Arrow-wrap the mock invocation so the callee never depends on a
  // `this` binding — sidesteps eslint's `unbound-method` rule.
  const store: OutboxStore = {
    claimBatch: (size) => claimBatch(size),
    markPublished: (id) => markPublished(id),
  };
  const queue: QueueProducer = { send: (msg) => send(msg) };

  const loggerInfo = vi.fn();
  const loggerWarn = vi.fn();
  const loggerError = vi.fn();
  const logger: Logger = {
    info: (msg, meta) => {
      loggerInfo(msg, meta);
    },
    warn: (msg, meta) => {
      loggerWarn(msg, meta);
    },
    error: (msg, meta) => {
      loggerError(msg, meta);
    },
  };

  return {
    store,
    queue,
    logger,
    claimBatch,
    markPublished,
    send,
    loggerInfo,
    loggerWarn,
    loggerError,
  };
}

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Happy path                                                         */
/* ------------------------------------------------------------------ */

describe('drainOutbox — happy path', () => {
  it('claims N rows, sends each one, marks each one as published, and returns the correct counts', async () => {
    const rows: ClaimedRow[] = [
      row({ id: 'aaaa', eventId: 'e-1', eventType: 'reservation.created' }),
      row({ id: 'bbbb', eventId: 'e-2', eventType: 'reservation.cancelled' }),
      row({ id: 'cccc', eventId: 'e-3', eventType: 'reservation.promoted' }),
    ];
    const d = makeDoubles(rows);

    const result = await drainOutbox({
      store: d.store,
      queue: d.queue,
      logger: d.logger,
    });

    expect(result).toEqual({ processed: 3, succeeded: 3, failed: 0 });
    // Default batch size propagates to the store.
    expect(d.claimBatch).toHaveBeenCalledTimes(1);
    expect(d.claimBatch).toHaveBeenCalledWith(DEFAULT_BATCH_SIZE);
    // Each row is sent exactly once, in claim order.
    expect(d.send).toHaveBeenCalledTimes(3);
    expect(d.markPublished).toHaveBeenCalledTimes(3);

    // `mock.calls` is `[id: string][]` because `markPublished` is
    // typed as `(id: string) => Promise<void>` — no casts needed.
    const markedIds = d.markPublished.mock.calls.map(([id]) => id);
    expect(markedIds).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('reconstructs a bus-ready envelope from the stored row', async () => {
    const stored = row({
      id: 'row-id',
      eventId: 'evt-id',
      eventType: 'auth.user.registered',
      payload: { userId: 'u-1', email: 'a@b.test' },
      occurredAt: new Date('2025-06-01T08:30:00.000Z'),
    });
    const d = makeDoubles([stored]);

    await drainOutbox({ store: d.store, queue: d.queue, logger: d.logger });

    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith({
      id: 'evt-id',
      type: 'auth.user.registered',
      // `occurredAt` is re-serialised back to ISO-8601 so the
      // envelope matches what `publish.ts` produces.
      occurredAt: '2025-06-01T08:30:00.000Z',
      payload: { userId: 'u-1', email: 'a@b.test' },
    });
  });

  it('honours a custom batchSize', async () => {
    const d = makeDoubles([]);

    await drainOutbox({
      store: d.store,
      queue: d.queue,
      logger: d.logger,
      batchSize: 25,
    });

    expect(d.claimBatch).toHaveBeenCalledWith(25);
  });
});

/* ------------------------------------------------------------------ */
/*  Empty batch                                                        */
/* ------------------------------------------------------------------ */

describe('drainOutbox — empty batch', () => {
  it('returns zero counts and skips the queue / markPublished entirely', async () => {
    const d = makeDoubles([]);

    const result = await drainOutbox({
      store: d.store,
      queue: d.queue,
      logger: d.logger,
    });

    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.markPublished).not.toHaveBeenCalled();
    // Empty-batch path still logs a single info line so operators
    // can tell the cron is running even when there is nothing to do.
    expect(d.loggerInfo).toHaveBeenCalledWith(
      'outbox drain: empty batch',
      expect.objectContaining({ batchSize: DEFAULT_BATCH_SIZE }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Queue send failure                                                 */
/* ------------------------------------------------------------------ */

describe('drainOutbox — queue send failure for one row', () => {
  it('leaves the failing row unmarked, still processes the others, returns the right counts', async () => {
    const rows: ClaimedRow[] = [
      row({ id: 'ok-1', eventId: 'e-ok-1' }),
      row({ id: 'boom', eventId: 'e-boom' }),
      row({ id: 'ok-2', eventId: 'e-ok-2' }),
    ];
    const d = makeDoubles(rows);

    // Fail only the middle row. The doubles helper installs a
    // resolving default, so we override it here to inspect the
    // event id and throw for the one we want to fail.
    d.send.mockImplementation((msg: unknown) => {
      const envelope = msg as { id: string };
      if (envelope.id === 'e-boom') {
        return Promise.reject(new Error('queue unreachable'));
      }
      return Promise.resolve();
    });

    const result = await drainOutbox({
      store: d.store,
      queue: d.queue,
      logger: d.logger,
    });

    expect(result).toEqual({ processed: 3, succeeded: 2, failed: 1 });

    // The failing row was attempted exactly once — no internal
    // retry loop (the drain leaves retries to the next cycle).
    expect(d.send).toHaveBeenCalledTimes(3);

    // Crucially, the failing row is NOT marked published. If we
    // marked it, the event would be lost — it has to remain
    // claimable on the next drain.
    const markedIds = d.markPublished.mock.calls.map(([id]) => id);
    expect(markedIds).toEqual(['ok-1', 'ok-2']);
    expect(markedIds).not.toContain('boom');

    // The failure is logged at warn level with enough metadata to
    // diagnose from the logs alone.
    expect(d.loggerWarn).toHaveBeenCalledWith(
      'outbox drain: queue send failed; leaving row for next drain',
      expect.objectContaining({
        outboxId: 'boom',
        eventId: 'e-boom',
        error: expect.objectContaining({ message: 'queue unreachable' }) as unknown,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Mark-published failure                                             */
/* ------------------------------------------------------------------ */

describe('drainOutbox — markPublished failure', () => {
  it('logs error and continues with the next row without aborting the batch', async () => {
    const rows: ClaimedRow[] = [
      row({ id: 'row-1', eventId: 'e-1' }),
      row({ id: 'row-2', eventId: 'e-2' }),
      row({ id: 'row-3', eventId: 'e-3' }),
    ];
    const d = makeDoubles(rows);

    // Fail only the second mark-published call. The queue send
    // succeeds for every row.
    d.markPublished.mockImplementation((id: string) => {
      if (id === 'row-2') {
        return Promise.reject(new Error('pg connection dropped'));
      }
      return Promise.resolve();
    });

    const result = await drainOutbox({
      store: d.store,
      queue: d.queue,
      logger: d.logger,
    });

    // All three rows were sent; two were stamped, one was not.
    expect(result).toEqual({ processed: 3, succeeded: 2, failed: 1 });
    expect(d.send).toHaveBeenCalledTimes(3);
    expect(d.markPublished).toHaveBeenCalledTimes(3);
    // Crucially, row-3 (after the failing row-2) was still
    // processed — mark-published failures do not abort the batch.
    const markedIds = d.markPublished.mock.calls.map(([id]) => id);
    expect(markedIds).toEqual(['row-1', 'row-2', 'row-3']);

    // A mark-published failure after a successful send is worth
    // an `error`-level log line: the queue has the event, but a
    // duplicate redelivery is now guaranteed on the next drain.
    expect(d.loggerError).toHaveBeenCalledWith(
      'outbox drain: markPublished failed after successful queue send',
      expect.objectContaining({
        outboxId: 'row-2',
        eventId: 'e-2',
        error: expect.objectContaining({ message: 'pg connection dropped' }) as unknown,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Defensive guards                                                   */
/* ------------------------------------------------------------------ */

describe('drainOutbox — defensive guards', () => {
  it('throws RangeError on non-integer batch size', async () => {
    const d = makeDoubles([]);

    await expect(
      drainOutbox({ store: d.store, queue: d.queue, batchSize: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      drainOutbox({ store: d.store, queue: d.queue, batchSize: -5 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      drainOutbox({ store: d.store, queue: d.queue, batchSize: 1.5 }),
    ).rejects.toBeInstanceOf(RangeError);

    // None of those reached the store.
    expect(d.claimBatch).not.toHaveBeenCalled();
  });

  it('propagates errors thrown by claimBatch', async () => {
    const d = makeDoubles([]);
    d.claimBatch.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(drainOutbox({ store: d.store, queue: d.queue, logger: d.logger })).rejects.toThrow(
      'db unavailable',
    );

    // A claim failure is infrastructural, not per-row. The worker
    // must not attempt queue traffic when it has no rows to send.
    expect(d.send).not.toHaveBeenCalled();
    expect(d.markPublished).not.toHaveBeenCalled();
  });
});

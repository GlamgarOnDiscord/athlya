/**
 * Outbox → Drain → Consumer integration test (slice B6.4).
 *
 * Stitches three modules end-to-end with **in-memory** doubles only —
 * no Cloudflare runtime, no Postgres, no Upstash:
 *
 *     producer ─► InMemoryOutbox.insert
 *                       │
 *                       ▼
 *               drainOutbox(store, queue)
 *                       │
 *                       ├─► InMemoryQueue.send (envelope)
 *                       └─► InMemoryOutbox.markPublished
 *                       │
 *                       ▼
 *           consumerLoop ─► assertNotSeen(redis, eventId)
 *                       │
 *                       ▼
 *               applySideEffect(event)
 *
 * The point of this suite is NOT to replace the focused unit tests
 * (`drain-worker.test.ts`, `dedup.test.ts`, `publish.test.ts`) — it
 * is to lock the WIRING between them. A regression in:
 *
 *   - the envelope shape `drainOutbox` reconstructs from a stored row,
 *   - the `event.id` field consumers dedup on,
 *   - the markPublished-after-send ordering,
 *
 * is invisible to the unit suites because each one stubs out the
 * neighbours. This integration suite catches those regressions by
 * running the full chain on real (in-memory) state and asserting the
 * domain side-effects observed downstream of the consumer.
 *
 * Coverage of the 5 critical events (Req 16.1–16.4, 17.4):
 *
 *   - `reservation.created`
 *   - `reservation.promoted`
 *   - `reservation.cancelled`
 *   - `members.export.requested`
 *   - `members.export.completed`
 *
 * Failure-mode coverage:
 *
 *   - queue.send() throws → row stays pending → next drain republishes.
 *   - markPublished() throws → row stays pending → consumer dedup
 *     absorbs the inevitable redelivery.
 *   - Empty drain after a clean cycle → no double publish.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertNotSeen } from '../../events/dedup.js';
import {
  drainOutbox,
  type ClaimedRow,
  type OutboxStore,
  type QueueProducer,
} from '../../events/drain-worker.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  In-memory outbox                                                   */
/* ------------------------------------------------------------------ */

/**
 * Pending row tracked by the in-memory outbox. The shape is a 1:1
 * subset of the Postgres `outbox` columns; the only difference is
 * that `publishedAt === null` means "drain me", just like the SQL
 * predicate `published_at IS NULL` in the real adapter.
 */
interface OutboxRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  attempts: number;
  publishedAt: Date | null;
}

/**
 * In-memory implementation of {@link OutboxStore} that mirrors the
 * `FOR UPDATE SKIP LOCKED` semantics of the real Postgres helper:
 *
 *   - `claimBatch(size)` returns up to `size` pending rows in
 *     `occurredAt` ASC order, bumps each row's `attempts` and stamps
 *     them as "claimed" so a concurrent claim would not see them.
 *   - `markPublished(id)` sets `publishedAt = now()` so the row is
 *     filtered out of subsequent claims.
 *   - `insert` is a test helper that mirrors `publish` writing to the
 *     outbox inside a transaction — exposed here so we do not have
 *     to depend on the real `publish` module (which pulls Drizzle).
 *
 * `markPublishedShouldFail` is a per-id failure switch so we can
 * exercise the "queue ack but DB stamp fails" path without breaking
 * the rest of the batch.
 */
class InMemoryOutbox implements OutboxStore {
  private readonly rows = new Map<string, OutboxRow>();
  private nextRowId = 1;
  /**
   * Per-row failure switch for {@link markPublished}. The test sets
   * `markPublishedShouldFail.add(id)` to make the next stamp throw
   * for that row exactly once.
   */
  public readonly markPublishedShouldFail = new Set<string>();

  /** Insert a new pending row. Returns the synthetic outbox id. */
  insert(event: {
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }): string {
    // Mirror the real adapter's `ON CONFLICT (event_id) DO NOTHING`.
    for (const row of this.rows.values()) {
      if (row.eventId === event.eventId) return row.id;
    }
    const id = `row-${String(this.nextRowId++).padStart(4, '0')}`;
    this.rows.set(id, {
      id,
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      publishedAt: null,
    });
    return id;
  }

  /**
   * Mirror of `claimBatch` from `@athlya/db/outbox`. Sorted by
   * `occurredAt` ASC so the FIFO contract the SQL helper guarantees
   * also holds here. We bump `attempts` synchronously to match the
   * `UPDATE … RETURNING` shape of the real query.
   */
  async claimBatch(size: number): Promise<readonly ClaimedRow[]> {
    const pending = [...this.rows.values()]
      .filter((r) => r.publishedAt === null)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, size);

    const claimed: ClaimedRow[] = pending.map((row) => {
      row.attempts += 1;
      return {
        id: row.id,
        eventId: row.eventId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
      };
    });

    // Mimic an awaitable I/O boundary. Without this, every
    // microtask runs before the test gets a chance to schedule
    // intermediate assertions.
    await Promise.resolve();
    return claimed;
  }

  async markPublished(id: string): Promise<void> {
    if (this.markPublishedShouldFail.delete(id)) {
      throw new Error(`pg-failure: cannot stamp ${id}`);
    }
    const row = this.rows.get(id);
    if (row !== undefined) {
      row.publishedAt = new Date();
    }
    await Promise.resolve();
  }

  /** Test helper: number of rows still waiting for the drain. */
  pendingCount(): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.publishedAt === null) n += 1;
    }
    return n;
  }
}

/* ------------------------------------------------------------------ */
/*  In-memory queue + redis                                            */
/* ------------------------------------------------------------------ */

/** Reconstructed envelope shape `drainOutbox` puts on the bus. */
interface BusEnvelope {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

/**
 * In-memory queue producer / consumer. Tracks every send in
 * `delivered`; tests assert against that array to verify the wire
 * shape `drainOutbox` puts on the bus is what consumers will see.
 *
 * `failOnce` lets the test reject the next send for a specific
 * `eventId` to exercise the retry-by-next-drain path without
 * breaking the rest of the batch.
 */
class InMemoryQueue implements QueueProducer {
  public readonly delivered: BusEnvelope[] = [];
  public readonly failOnce = new Set<string>();

  async send(message: unknown): Promise<void> {
    const envelope = message as BusEnvelope;
    if (this.failOnce.delete(envelope.id)) {
      throw new Error(`queue-failure: ${envelope.id}`);
    }
    this.delivered.push(envelope);
    await Promise.resolve();
  }
}

/**
 * Minimal Upstash-shaped Redis double for `assertNotSeen`. Only the
 * `set(key, value, { ex, nx })` overload is used. The fake is
 * intentionally distinct from `dedup.test.ts`'s — that one tests the
 * primitive in isolation; this one stitches it into the consumer
 * loop, so the surface stays minimal.
 */
class FakeRedis {
  readonly store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<'OK' | null> {
    if (opts?.nx === true && this.store.has(key)) return null;
    this.store.set(key, value);
    await Promise.resolve();
    return 'OK';
  }
}

const asRedis = (r: FakeRedis): Redis => r as unknown as Redis;

/* ------------------------------------------------------------------ */
/*  Consumer loop                                                       */
/* ------------------------------------------------------------------ */

/**
 * Generic consumer the integration test runs over `queue.delivered`.
 * Mirrors the contract every real consumer (notifications, billing,
 * audit) is required to follow:
 *
 *   1. Call `assertNotSeen(redis, event.id)` first — if it returns
 *      `false`, skip silently (Req 17.4 dedup window).
 *   2. Otherwise, invoke the per-event-type side effect.
 *
 * The side-effect map is supplied per test so the suite can assert
 * exactly how many times each handler ran.
 */
async function consume(
  queue: InMemoryQueue,
  redis: Redis,
  handlers: Record<string, (event: BusEnvelope) => void>,
): Promise<{ processed: number; deduped: number; missingHandler: number }> {
  let processed = 0;
  let deduped = 0;
  let missingHandler = 0;

  for (const envelope of queue.delivered) {
    const fresh = await assertNotSeen(redis, envelope.id);
    if (!fresh) {
      deduped += 1;
      continue;
    }
    const handler = handlers[envelope.type];
    if (handler === undefined) {
      missingHandler += 1;
      continue;
    }
    handler(envelope);
    processed += 1;
  }
  return { processed, deduped, missingHandler };
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Sample payloads for each of the 5 critical events. Shapes match the
 * real schemas (`packages/shared/src/events.ts`) just well enough that
 * `drainOutbox` round-trips them — this suite does NOT re-test the
 * Zod parsers (that lives in `packages/shared/tests/events.test.ts`).
 */
const RESERVATION_ID = '00000000-0000-4000-8000-000000000001';
const CLASS_ID = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-000000000003';
const EXPORT_JOB_ID = '00000000-0000-4000-8000-000000000004';
const STUDIO_ID = '00000000-0000-4000-8000-000000000005';

interface SeedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

const CRITICAL_EVENTS: readonly SeedEvent[] = [
  {
    eventId: '11111111-1111-4000-8000-000000000001',
    eventType: 'reservation.created',
    payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
    occurredAt: new Date('2025-01-01T08:00:00.000Z'),
  },
  {
    eventId: '22222222-2222-4000-8000-000000000002',
    eventType: 'reservation.promoted',
    payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
    occurredAt: new Date('2025-01-01T08:01:00.000Z'),
  },
  {
    eventId: '33333333-3333-4000-8000-000000000003',
    eventType: 'reservation.cancelled',
    payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
    occurredAt: new Date('2025-01-01T08:02:00.000Z'),
  },
  {
    eventId: '44444444-4444-4000-8000-000000000004',
    eventType: 'members.export.requested',
    payload: { exportJobId: EXPORT_JOB_ID, userId: USER_ID, studioId: STUDIO_ID },
    occurredAt: new Date('2025-01-01T08:03:00.000Z'),
  },
  {
    eventId: '55555555-5555-4000-8000-000000000005',
    eventType: 'members.export.completed',
    payload: {
      exportJobId: EXPORT_JOB_ID,
      userId: USER_ID,
      downloadUrl: 'https://r2.athlya.app/export/abc.zip',
      expiresAt: '2025-01-04T08:03:00.000Z',
    },
    occurredAt: new Date('2025-01-01T08:04:00.000Z'),
  },
];

const SILENT_LOGGER = {
  info: () => {
    /* swallowed in tests */
  },
  warn: () => {
    /* swallowed in tests */
  },
  error: () => {
    /* swallowed in tests */
  },
};

/* ------------------------------------------------------------------ */
/*  Setup                                                               */
/* ------------------------------------------------------------------ */

let outbox: InMemoryOutbox;
let queue: InMemoryQueue;
let redis: FakeRedis;

beforeEach(() => {
  outbox = new InMemoryOutbox();
  queue = new InMemoryQueue();
  redis = new FakeRedis();
});

/* ------------------------------------------------------------------ */
/*  Happy path — 5 critical events                                      */
/* ------------------------------------------------------------------ */

describe('outbox → drain → consumer (5 critical events)', () => {
  it('publishes, drains and consumes each event with the right side-effects', async () => {
    // Seed the outbox with one pending row per critical event.
    for (const evt of CRITICAL_EVENTS) outbox.insert(evt);

    // Drain.
    const result = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });

    // Every row was claimed, sent and stamped.
    expect(result).toEqual({ processed: 5, succeeded: 5, failed: 0, released: 0 });
    expect(outbox.pendingCount()).toBe(0);
    expect(queue.delivered).toHaveLength(5);

    // Wire-shape sanity: each delivered envelope carries the
    // event id (consumer dedup key) and a serialised occurredAt.
    const deliveredIds = queue.delivered.map((e) => e.id);
    expect(deliveredIds).toEqual(CRITICAL_EVENTS.map((e) => e.eventId));
    for (const env of queue.delivered) {
      expect(typeof env.occurredAt).toBe('string');
      expect(env.payload).toBeTypeOf('object');
    }

    // Consumer side-effects: one handler per type, asserted by
    // call count. A regression in the type discriminator would
    // surface here as a missing handler invocation.
    const reservationCreated = vi.fn();
    const reservationPromoted = vi.fn();
    const reservationCancelled = vi.fn();
    const exportRequested = vi.fn();
    const exportCompleted = vi.fn();

    const summary = await consume(queue, asRedis(redis), {
      'reservation.created': reservationCreated,
      'reservation.promoted': reservationPromoted,
      'reservation.cancelled': reservationCancelled,
      'members.export.requested': exportRequested,
      'members.export.completed': exportCompleted,
    });

    expect(summary).toEqual({ processed: 5, deduped: 0, missingHandler: 0 });
    expect(reservationCreated).toHaveBeenCalledTimes(1);
    expect(reservationPromoted).toHaveBeenCalledTimes(1);
    expect(reservationCancelled).toHaveBeenCalledTimes(1);
    expect(exportRequested).toHaveBeenCalledTimes(1);
    expect(exportCompleted).toHaveBeenCalledTimes(1);

    // Dedup keys exist for every event id under the canonical prefix.
    for (const evt of CRITICAL_EVENTS) {
      expect(redis.store.has(`events:seen:${evt.eventId}`)).toBe(true);
    }
  });

  it('a second drain after a clean cycle is a no-op (no double publish)', async () => {
    for (const evt of CRITICAL_EVENTS) outbox.insert(evt);

    await drainOutbox({ store: outbox, queue, logger: SILENT_LOGGER });
    const beforeRedrain = queue.delivered.length;

    const second = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });

    expect(second).toEqual({ processed: 0, succeeded: 0, failed: 0, released: 0 });
    expect(queue.delivered).toHaveLength(beforeRedrain);
  });
});

/* ------------------------------------------------------------------ */
/*  Failure modes                                                       */
/* ------------------------------------------------------------------ */

describe('outbox → drain → consumer — failure modes', () => {
  it('queue.send failure: row stays pending, next drain republishes once', async () => {
    for (const evt of CRITICAL_EVENTS) outbox.insert(evt);

    // Fail the FIRST send for the `reservation.promoted` event
    // exactly once. `failOnce` is a Set, so the next attempt
    // succeeds.
    const promotedId = CRITICAL_EVENTS[1]!.eventId;
    queue.failOnce.add(promotedId);

    // Drain #1: 4 succeed, 1 fails.
    const first = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });
    expect(first).toEqual({ processed: 5, succeeded: 4, failed: 1, released: 0 });
    expect(outbox.pendingCount()).toBe(1);
    // The failing row was NOT marked published — the queue does
    // not have it.
    expect(queue.delivered.find((e) => e.id === promotedId)).toBeUndefined();

    // Drain #2: the leftover row goes through.
    const second = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, released: 0 });
    expect(outbox.pendingCount()).toBe(0);

    // Total publishes: exactly 5 (one per event). No duplicate.
    const ids = queue.delivered.map((e) => e.id).sort();
    const expected = CRITICAL_EVENTS.map((e) => e.eventId).sort();
    expect(ids).toEqual(expected);
  });

  it('markPublished failure: queue keeps the event, consumer dedup absorbs the redelivery', async () => {
    for (const evt of CRITICAL_EVENTS) outbox.insert(evt);

    // Fail the markPublished for the `members.export.requested`
    // row. The queue.send happens BEFORE the stamp, so the queue
    // already has it — the row will simply look pending again to
    // the next drain.
    const stampFailureRowId = 'row-0004'; // 4th inserted in seed order
    outbox.markPublishedShouldFail.add(stampFailureRowId);

    const first = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });
    // 5 sends happened; only 4 stamps succeeded.
    expect(first).toEqual({ processed: 5, succeeded: 4, failed: 1, released: 0 });
    expect(queue.delivered).toHaveLength(5);
    expect(outbox.pendingCount()).toBe(1);

    // Drain #2: the leftover row is republished — that's a
    // legitimate at-least-once duplicate. The queue now has 6
    // envelopes, two of which share the same event id.
    const second = await drainOutbox({
      store: outbox,
      queue,
      logger: SILENT_LOGGER,
    });
    expect(second).toEqual({ processed: 1, succeeded: 1, failed: 0, released: 0 });
    expect(queue.delivered).toHaveLength(6);

    const duplicateId = CRITICAL_EVENTS[3]!.eventId;
    const duplicates = queue.delivered.filter((e) => e.id === duplicateId);
    expect(duplicates).toHaveLength(2);

    // Consumer-side dedup: even with a duplicate envelope on the
    // bus, the side-effect runs exactly once.
    const exportRequested = vi.fn();
    const summary = await consume(queue, asRedis(redis), {
      'reservation.created': () => undefined,
      'reservation.promoted': () => undefined,
      'reservation.cancelled': () => undefined,
      'members.export.requested': exportRequested,
      'members.export.completed': () => undefined,
    });

    // 5 fresh + 1 duplicate skipped by dedup.
    expect(summary.processed).toBe(5);
    expect(summary.deduped).toBe(1);
    expect(exportRequested).toHaveBeenCalledTimes(1);
  });
});

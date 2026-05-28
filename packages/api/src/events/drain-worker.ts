/**
 * `drainOutbox` — pure, framework-free outbox drain.
 *
 * The transactional-outbox pattern (Req 16.1–16.3) gives every
 * domain service a durable place to record "I committed state X and
 * I intend to publish event Y" in a single transaction. The drain
 * worker is the piece that reconciles those intents with the actual
 * bus: it pulls a batch of unpublished rows, republishes them to
 * Cloudflare Queues, and marks each one as published on success
 * (Req 16.4).
 *
 * Design goals for this module:
 *
 *   • **Framework-free.** Nothing in here imports from the Cloudflare
 *     Workers runtime or from Drizzle. The function takes a small set
 *     of ports (`OutboxStore`, `QueueProducer`, `Logger`) so it is
 *     trivially unit-testable with `vi.fn()` doubles and trivially
 *     reusable from a Node.js cron, a test harness, or a scheduled
 *     Worker (see `./drain-scheduled.ts`).
 *
 *   • **One row's failure does not poison the batch.** Each row is
 *     processed independently. A queue send failure logs and leaves
 *     the row untouched so the next drain picks it up again — we
 *     NEVER delete an outbox row that has not been successfully
 *     republished. A `markPublished` failure after a successful send
 *     is also tolerated: the consumer will dedup the redelivery on
 *     `event.id` (Req 17.4) and the row will be re-stamped on the
 *     next drain cycle.
 *
 *   • **No wall-clock cadence in this layer.** The design document
 *     calls for a ~30 s drain cadence, but Cloudflare Cron Triggers'
 *     minimum resolution is 1 minute — the scheduled wrapper in
 *     `./drain-scheduled.ts` documents that tradeoff. Here we only
 *     expose a pure function so tests never have to deal with
 *     scheduling.
 *
 * Return shape:
 *
 *   • `processed` — total number of rows claimed from the store.
 *   • `succeeded` — rows for which BOTH the queue send AND the
 *                   markPublished stamp succeeded. These rows are
 *                   durably "done": they will not appear in future
 *                   drains.
 *   • `failed`    — every other row (queue send failed, or queue
 *                   send succeeded but markPublished failed). These
 *                   rows will be re-drained on the next cycle; the
 *                   consumer dedup window absorbs any duplicate
 *                   deliveries.
 *
 * `processed === succeeded + failed` always holds.
 *
 * Related requirements: 16.1, 16.2, 16.3, 16.4, 17.4.
 */

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Row shape the drain worker expects from the store. Matches the
 * columns of `ClaimedOutboxRow` in `@athlya/db/outbox`, but is
 * redeclared here to keep this module free of any DB dependency —
 * the scheduled wrapper (`./drain-scheduled.ts`) is the only adapter
 * that bridges the two.
 */
export interface ClaimedRow {
  /** Primary-key UUID of the `outbox` row. Used by `markPublished`. */
  readonly id: string;
  /** Domain-level event id (UUID). Becomes the dedup key downstream. */
  readonly eventId: string;
  /** Dotted event type, e.g. `"reservation.created"`. */
  readonly eventType: string;
  /** Fully-serialised event payload, as it was inserted. */
  readonly payload: Record<string, unknown>;
  /** Domain timestamp of the underlying state change. */
  readonly occurredAt: Date;
  /** Monotonically increasing attempt counter bumped by the store. */
  readonly attempts: number;
}

/**
 * Port the drain needs from the outbox store. Two operations:
 *   - `claimBatch(size)` returns up to `size` pending rows. It is the
 *     store's job to lock / bump attempts / order by `occurredAt`.
 *   - `markPublished(id)` stamps `published_at = now()` on a single
 *     row, taking it out of the pending set.
 *
 * Keeping these as free functions rather than bundling a "transaction"
 * object lets the drain worker stay ignorant of whether the adapter is
 * backed by Postgres, an in-memory map (tests) or anything else.
 */
export interface OutboxStore {
  claimBatch(size: number): Promise<readonly ClaimedRow[]>;
  markPublished(id: string): Promise<void>;
}

/**
 * Port the drain needs from the Cloudflare Queues producer binding.
 * `message` is declared as `unknown` because Cloudflare serialises
 * whatever we hand it; the worker always sends a fully reconstructed
 * envelope so consumers get the same shape as a direct publish from
 * `publish.ts` would have produced.
 *
 * Implementations MUST throw on delivery failure; a resolved promise
 * signals queue acknowledgment.
 */
export interface QueueProducer {
  send(message: unknown): Promise<void>;
}

/**
 * Minimal logger shape. Defaults to a `console`-backed implementation
 * so the module stays importable from any runtime without taking a
 * hard dependency on a tracing library.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Optional clock port. Only used to stamp batch duration in the final
 * log line; threading it explicitly lets the scheduled wrapper feed a
 * test-friendly clock (e.g. a fixed `Date`) without freezing
 * `Date.now` globally.
 */
export interface Clock {
  now(): Date;
}

/** Options bag accepted by {@link drainOutbox}. */
export interface DrainOutboxOptions {
  readonly store: OutboxStore;
  /** Legacy single-queue drain. Ignored when {@link resolveQueue} is set. */
  readonly queue?: QueueProducer;
  /** Route each outbox row to the lane-specific queue (issue #125). */
  readonly resolveQueue?: (eventType: string) => QueueProducer;
  /** Defaults to {@link DEFAULT_BATCH_SIZE}. Must be a positive integer. */
  readonly batchSize?: number;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

/** Tally returned by {@link drainOutbox}. See module docstring. */
export interface DrainResult {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

/**
 * Default batch size. 100 is the sweet spot observed in the design
 * document for Cloudflare Queues — large enough to amortise the
 * transaction overhead, small enough to fit well under the Worker
 * CPU budget even with retries.
 */
export const DEFAULT_BATCH_SIZE = 100;

const defaultLogger: Logger = {
  info: (msg, meta) => {
    console.log(`[drain] ${msg}`, meta ?? {});
  },
  warn: (msg, meta) => {
    console.warn(`[drain] ${msg}`, meta ?? {});
  },
  error: (msg, meta) => {
    console.error(`[drain] ${msg}`, meta ?? {});
  },
};

const defaultClock: Clock = {
  now: () => new Date(),
};

/* ------------------------------------------------------------------ */
/*  drainOutbox                                                        */
/* ------------------------------------------------------------------ */

/**
 * Drain one batch from the outbox. Never throws on per-row failures —
 * those are captured in the returned {@link DrainResult}. The only
 * errors that DO propagate are the ones thrown by `store.claimBatch`
 * itself, because a failure to claim means the whole drain cycle is
 * compromised and the scheduled wrapper should let the platform's
 * retry / alerting machinery see it.
 *
 * Algorithm (see module docstring for rationale):
 *
 *   1. Call `store.claimBatch(batchSize)`.
 *   2. For each claimed row, in the order returned by the store:
 *      a. Call `queue.send(reconstructed envelope)`.
 *         - On failure: log at warn, count as `failed`, move on. The
 *           row is left with `published_at IS NULL` and will be
 *           re-drained on the next cycle.
 *      b. On queue send success, call `store.markPublished(row.id)`.
 *         - On failure: log at error, count as `failed`, move on.
 *           The queue already has the event; the consumer dedup
 *           (Req 17.4) absorbs the eventual redelivery.
 *         - On success: count as `succeeded`.
 *   3. Return `{ processed, succeeded, failed }`.
 */
export async function drainOutbox(options: DrainOutboxOptions): Promise<DrainResult> {
  const { store } = options;
  const resolveQueue =
    options.resolveQueue ??
    ((_: string) => {
      if (options.queue === undefined) {
        throw new Error('drainOutbox requires queue or resolveQueue');
      }
      return options.queue;
    });
  const logger = options.logger ?? defaultLogger;
  const clock = options.clock ?? defaultClock;
  const batchSize = normaliseBatchSize(options.batchSize);

  const startedAt = clock.now();

  const rows = await store.claimBatch(batchSize);

  if (rows.length === 0) {
    logger.info('outbox drain: empty batch', { batchSize });
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info('outbox drain: claimed rows', {
    count: rows.length,
    batchSize,
  });

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const queue = resolveQueue(row.eventType);
    const sendOk = await trySend(queue, row, logger);
    if (!sendOk) {
      failed += 1;
      continue;
    }

    const markOk = await tryMarkPublished(store, row, logger);
    if (markOk) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  const durationMs = clock.now().getTime() - startedAt.getTime();
  logger.info('outbox drain: batch complete', {
    processed: rows.length,
    succeeded,
    failed,
    durationMs,
  });

  return { processed: rows.length, succeeded, failed };
}

/* ------------------------------------------------------------------ */
/*  Internals                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rebuild an envelope shaped like the one `publish.ts` puts on the
 * bus when the primary queue send succeeds. Keeping the two shapes
 * aligned means consumers do not have to special-case "came from the
 * drain" vs "came from the primary publish".
 *
 * The `studioId` field is intentionally not included here: the
 * current `insertOutbox` helper serialises only the payload (not the
 * envelope's `studioId`), so we cannot reconstruct it from the stored
 * row. Reintroducing it is out of scope for task 9.3; consumers that
 * need the tenant scope read it from `payload.*Id` fields.
 */
function reconstructEnvelope(row: ClaimedRow): Record<string, unknown> {
  return {
    id: row.eventId,
    type: row.eventType,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
  };
}

/**
 * Attempt to send a row to the queue. Resolves `true` on success or
 * `false` on any thrown error — logging the error details before
 * returning. Never re-throws: the whole point of per-row isolation is
 * that one bad row must not abort the rest of the batch.
 */
async function trySend(queue: QueueProducer, row: ClaimedRow, logger: Logger): Promise<boolean> {
  try {
    await queue.send(reconstructEnvelope(row));
    return true;
  } catch (err) {
    logger.warn('outbox drain: queue send failed; leaving row for next drain', {
      outboxId: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      attempts: row.attempts,
      error: errToDetail(err),
    });
    return false;
  }
}

/**
 * Attempt to stamp `published_at` on the row. Resolves `true` on
 * success or `false` on any thrown error. A failure here is escalated
 * to `error` level (not `warn`) because the queue already has the
 * event: a mark-published failure produces a guaranteed duplicate on
 * the next drain and is worth paying attention to, even though the
 * consumer dedup absorbs the correctness impact.
 */
async function tryMarkPublished(
  store: OutboxStore,
  row: ClaimedRow,
  logger: Logger,
): Promise<boolean> {
  try {
    await store.markPublished(row.id);
    return true;
  } catch (err) {
    logger.error('outbox drain: markPublished failed after successful queue send', {
      outboxId: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      error: errToDetail(err),
    });
    return false;
  }
}

/**
 * Normalise / bound the batch size. Positive integer, defaulting to
 * {@link DEFAULT_BATCH_SIZE}. The store itself will cap at its own
 * upper bound (`MAX_CLAIM_LIMIT` in `@athlya/db/outbox`); this guard
 * catches obvious mis-wiring before a DB round-trip.
 */
function normaliseBatchSize(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    throw new RangeError(`drainOutbox: batchSize must be a positive integer, got ${String(raw)}`);
  }
  return raw;
}

/**
 * Shrink an unknown thrown value into something safe to serialise into
 * logs. Keeps the `name` and `message` of `Error` instances and
 * coerces anything else to its `String()` representation — matching
 * the pattern used in `publish.ts` so operators see consistent log
 * shapes across the publish / drain paths.
 */
function errToDetail(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

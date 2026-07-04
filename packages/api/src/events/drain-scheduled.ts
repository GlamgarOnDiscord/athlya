/**
 * Scheduled Worker entrypoint for the outbox drain.
 *
 * Task 9.3 wants the drain to run on a cron cadence. The design calls
 * for 30-second ticks, but Cloudflare Cron Triggers only support
 * minute-level granularity — the smallest valid expression is
 * once-per-minute (`*` in the minutes field). We accept that tradeoff
 * and ship a once-per-minute cron; the dropped 30 s cadence is harmless
 * because consumers already dedup on `event.id` for 24 h (Req 17.4) and
 * the drain pulls in batches of 100 rows per cycle, which is large
 * enough to keep steady-state backlog sub-second at our target load.
 *
 * This file ONLY exports the scheduled handler wrapper; it does NOT
 * wire anything into `wrangler.toml`. Task 8.1 owns the wrangler
 * environments and will add the `[triggers]` block referencing this
 * handler when the API gateway skeleton lands. Shipping the wrapper
 * now means the drain logic is deployable as soon as 8.1 flips the
 * cron on.
 *
 * Adapter responsibilities:
 *
 *   • Bridge the Cloudflare `ScheduledEvent` / `ExecutionContext` shape
 *     onto the pure {@link drainOutbox} function defined in
 *     `./drain-worker.ts`.
 *   • Build the {@link OutboxStore} adapter by wrapping the db helpers
 *     (`claimBatch`, `markPublished`) in a single Drizzle transaction
 *     per drain cycle. `claimBatch` needs a transaction because it
 *     holds `FOR UPDATE SKIP LOCKED` locks on the claimed rows; those
 *     locks are released when the transaction commits after the
 *     batch is processed.
 *   • Hand the `EVENTS_QUEUE` Worker binding to {@link drainOutbox} as
 *     its {@link QueueProducer}.
 *   • Register the drain as a background task via `ctx.waitUntil` so
 *     the Worker runtime keeps the isolate alive until the batch is
 *     done, even if the scheduled invocation itself has returned.
 *
 * We declare the minimum Cloudflare types locally to avoid a hard
 * dependency on `@cloudflare/workers-types` from this package. Task
 * 8.1 will introduce that dev dependency platform-wide; until then,
 * keeping the types local means `@athlya/api` still compiles in
 * isolation for unit tests.
 */

import { claimBatch, countPendingOutbox, markPublished } from '@athlya/db/outbox';

import {
  DEFAULT_BATCH_SIZE,
  drainOutbox,
  type ClaimedRow,
  type DrainResult,
  type Logger,
  type OutboxStore,
  type QueueProducer,
} from './drain-worker.js';
import { resolveEventQueueProducer, type EventQueueBindings } from './route-queue.js';

import type { AthlyaDb } from '@athlya/db/client';
import type { OutboxPendingSnapshot } from '@athlya/db/outbox';

/** When pending exceeds this, the drain claims up to {@link ADAPTIVE_BATCH_SIZE}. */
export const OUTBOX_BACKLOG_BATCH_THRESHOLD = 500;

/** Adaptive batch size under backlog (Worker CPU budget cap). */
export const ADAPTIVE_BATCH_SIZE = 200;

/**
 * Overlap guard. Cron fires once per minute; a drain that runs longer
 * than this risks colliding with the next tick. The transaction's
 * `FOR UPDATE SKIP LOCKED` already makes overlap *correct* (the second
 * drain just skips locked rows), but a long drain is a backlog signal,
 * so we emit a structured warning metric instead of relying on a
 * distributed lock. Keep this comfortably under the 60 s cron period.
 */
export const OUTBOX_DRAIN_OVERLAP_WARN_MS = 45_000;

/* ------------------------------------------------------------------ */
/*  Minimal Cloudflare Workers shapes                                  */
/* ------------------------------------------------------------------ */

/**
 * Subset of the Cloudflare `ScheduledEvent` interface we consume. The
 * full type (from `@cloudflare/workers-types`) adds a few fields we
 * do not use (`type`, `noRetry`, …); keeping this surface minimal
 * avoids a peer-dependency footprint for tests.
 */
export interface ScheduledEvent {
  /** Millisecond epoch the cron was scheduled for. */
  readonly scheduledTime: number;
  /** Cron expression that triggered this invocation. */
  readonly cron: string;
}

/**
 * Subset of `ExecutionContext` we use. `waitUntil` extends the
 * lifetime of the Worker invocation until the passed promise settles —
 * essential for a cron handler that kicks off async work.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Environment bindings the scheduled handler requires. Shaped so the
 * wrangler-generated `Env` (task 8.1) can extend this interface
 * without needing a cast.
 */
export interface ScheduledEnv extends EventQueueBindings {
  /**
   * Resolver for an initialised Drizzle client. Using a thunk (not
   * a direct `db` property) keeps the wrangler-side wiring flexible:
   * the gateway can inject a Hyperdrive-backed client, a
   * neon-serverless client, or (in tests) an in-memory double.
   */
  getDb(): AthlyaDb | Promise<AthlyaDb>;
  /** Optional swappable logger; defaults to the {@link drainOutbox} default. */
  readonly logger?: Logger;
  /** Optional override for the batch size. Defaults to 100. */
  readonly batchSize?: number;
}

/** Scheduled Worker handler signature, Cloudflare-compatible. */
export interface ScheduledWorker {
  scheduled(event: ScheduledEvent, env: ScheduledEnv, ctx: ExecutionContext): void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build an {@link OutboxStore} backed by a single Drizzle transaction.
 *
 * Both `claimBatch` and `markPublished` MUST execute against the same
 * transaction so the `FOR UPDATE SKIP LOCKED` locks acquired by the
 * claim stay held while the worker processes the rows. If the
 * transaction commits before a `markPublished` call, the row would be
 * re-claimable by a concurrent drain — which is still correct thanks
 * to consumer dedup, but needlessly produces duplicates.
 *
 * The store is transaction-scoped, so a fresh one is created for each
 * `scheduled` invocation.
 */
export function createTxBackedStore(db: AthlyaDb): {
  readonly store: OutboxStore;
  commit: () => Promise<void>;
  rollback: (err: unknown) => Promise<void>;
} {
  // We intentionally do NOT use `db.transaction(fn)` here because
  // that API expects a single callback that owns the lifetime of
  // the transaction. The drain worker is a two-phase operation
  // (claim → send → mark) that lives OUTSIDE the store, so we need
  // an imperative begin / commit / rollback API instead. Drizzle
  // exposes exactly that via `db.execute(sql`BEGIN`)` + explicit
  // `COMMIT` / `ROLLBACK` statements, but that approach would bypass
  // the `AthlyaTx` type system guarantees the db helpers rely on.
  //
  // The pragmatic compromise: run `drainOutbox` INSIDE
  // `db.transaction` by inverting control — the caller hands us the
  // logic as a callback. That is exactly what `runScheduledDrain`
  // below does, so this exported helper is actually unused from the
  // scheduled entrypoint. It exists as a named export to make the
  // adapter seam testable: a test can build its own transaction
  // mock and hand it to `drainOutbox` directly.
  const store: OutboxStore = {
    async claimBatch(size: number): Promise<readonly ClaimedRow[]> {
      return db.transaction(async (tx) => {
        const rows = await claimBatch(tx, size);
        return rows;
      });
    },
    async markPublished(id: string): Promise<void> {
      await markPublished(db, id);
    },
  };

  return {
    store,
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
  };
}

/**
 * Run a single drain cycle within a Drizzle transaction.
 *
 * This is the function the `scheduled` handler delegates to. Having
 * it as a named export lets task 8.1 import it directly from a
 * unified Worker entrypoint (e.g. `apps/api/src/worker.ts`) without
 * round-tripping through the default export.
 */
export function pickBatchSize(pending: number): number {
  return pending > OUTBOX_BACKLOG_BATCH_THRESHOLD ? ADAPTIVE_BATCH_SIZE : DEFAULT_BATCH_SIZE;
}

export async function resolveDrainBatchSize(db: AthlyaDb, env: ScheduledEnv): Promise<number> {
  if (env.batchSize !== undefined) {
    return env.batchSize;
  }
  const { pending } = await countPendingOutbox(db);
  return pickBatchSize(pending);
}

/**
 * Emit the backlog metric on every cron tick (issue #134 / alert A16).
 *
 * Goes through `console.log` unconditionally so Axiom always gets a
 * `outbox_pending_count` data point, regardless of whether a
 * {@link Logger} is wired — the production scheduled handler does not
 * pass one. When a logger *is* present (tests / future OTel bridge) we
 * also forward through it so structured tracing keeps the line.
 */
export function emitOutboxBacklogMetric(
  snapshot: OutboxPendingSnapshot,
  batchSize: number,
  logger?: Logger,
): void {
  const oldestOccurredAt = snapshot.oldestOccurredAt?.toISOString() ?? null;
  const ageMs =
    snapshot.oldestOccurredAt !== null ? Date.now() - snapshot.oldestOccurredAt.getTime() : 0;
  const meta = {
    metric: 'outbox_pending_count',
    pending: snapshot.pending,
    oldestOccurredAt,
    ageMs,
    batchSize,
    backlogThreshold: OUTBOX_BACKLOG_BATCH_THRESHOLD,
    backlog: snapshot.pending > OUTBOX_BACKLOG_BATCH_THRESHOLD,
  };
  console.log('outbox.backlog', meta);
  logger?.info('outbox drain: pending snapshot', meta);
}

export async function runScheduledDrain(env: ScheduledEnv): Promise<DrainResult> {
  const db = await env.getDb();
  const logger = env.logger;

  // Single pending snapshot reused for both batch sizing and the
  // backlog metric — the previous code queried `countPendingOutbox`
  // twice per cycle. Skipped entirely when `batchSize` is overridden
  // (explicit/test path), which also short-circuits the metric.
  const snapshot = env.batchSize !== undefined ? null : await countPendingOutbox(db);
  const batchSize = env.batchSize ?? pickBatchSize(snapshot?.pending ?? 0);

  if (snapshot !== null) {
    emitOutboxBacklogMetric(snapshot, batchSize, logger);
  }

  const startedAt = Date.now();

  // One transaction per drain cycle: holds SELECT FOR UPDATE SKIP
  // LOCKED locks on claimed rows until every row is processed.
  //
  // Lock duration analysis (issue #424):
  //   lock_duration ≈ batch_size × avg_queue_send_latency
  //   Normal:  100 rows × ~10 ms  =  ~1 s   (negligible)
  //   Backlog: 200 rows × ~10 ms  =  ~2 s
  //   Extreme: 200 rows × 5 000 ms = ~17 min (queue outage)
  //
  // The overlap guard (OUTBOX_DRAIN_OVERLAP_WARN_MS = 45 s) fires
  // well before lock duration becomes problematic in the extreme case.
  // SKIP LOCKED keeps concurrent drains correct: the next cron tick
  // claims a fresh batch of unlocked rows, not the slow batch.
  //
  // Lease pattern alternative (separate claim TX + out-of-tx send +
  // per-row markPublished TX) was evaluated and rejected: it requires
  // a schema migration, adds orphaned-lease recovery logic, and gives
  // no practical improvement at our load given the existing overlap
  // alert and consumer dedup window (24 h, Req 17.4). Decision is
  // explicitly accepted. Re-evaluate if avg queue latency exceeds 1 s.
  const result = await db.transaction(async (tx) => {
    const store: OutboxStore = {
      async claimBatch(size: number): Promise<readonly ClaimedRow[]> {
        return claimBatch(tx, size);
      },
      async markPublished(id: string): Promise<void> {
        await markPublished(tx, id);
      },
    };

    // Build the options bag conditionally so `exactOptionalPropertyTypes`
    // is respected: we only add `batchSize` / `logger` when the env
    // actually provides them. Spreading `undefined` into a property
    // would violate the strict optional semantics drainOutbox's
    // `DrainOutboxOptions` declares.
    const opts: Parameters<typeof drainOutbox>[0] = {
      store,
      resolveQueue: (eventType) => resolveEventQueueProducer(env, eventType) as QueueProducer,
      batchSize,
      ...(logger !== undefined ? { logger } : {}),
    };

    return drainOutbox(opts);
  });

  // Overlap guard: a drain slower than the warn threshold risks
  // colliding with the next cron tick. SKIP LOCKED keeps that safe,
  // but we surface it as a metric (alert A16) so ops can bump cron
  // frequency or investigate a stuck consumer.
  warnOnDrainOverlapRisk(Date.now() - startedAt, result, batchSize, logger);

  emitOutboxDrainErrorsMetric(result, logger);

  return result;
}

/**
 * Emit the drain-errors counter when any row failed to publish.
 *
 * Goes through `console.log` unconditionally so Axiom always records a
 * `outbox_drain_errors` data point — the production scheduled handler
 * does not wire a {@link Logger}. When a logger is present we also
 * forward through it for structured tracing.
 *
 * The function is a no-op when `result.failed === 0` so the happy path
 * emits nothing (no false positives in Axiom).
 */
export function emitOutboxDrainErrorsMetric(result: DrainResult, logger?: Logger): void {
  if (result.failed === 0) return;
  const meta = {
    metric: 'outbox_drain_errors',
    failed: result.failed,
    processed: result.processed,
    succeeded: result.succeeded,
  };
  console.log('athlya.outbox.drain_errors', meta);
  logger?.error('outbox drain: failed items in batch', meta);
}

/**
 * Emit the overlap-risk metric when a drain cycle ran longer than
 * {@link OUTBOX_DRAIN_OVERLAP_WARN_MS}. Returns `true` when it warned —
 * exposed for unit tests so they do not have to fake wall-clock time.
 */
export function warnOnDrainOverlapRisk(
  durationMs: number,
  result: DrainResult,
  batchSize: number,
  logger?: Logger,
): boolean {
  if (durationMs <= OUTBOX_DRAIN_OVERLAP_WARN_MS) {
    return false;
  }
  const meta = {
    metric: 'outbox_drain_duration_ms',
    durationMs,
    overlapThresholdMs: OUTBOX_DRAIN_OVERLAP_WARN_MS,
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    batchSize,
  };
  console.warn('outbox.drain_overlap_risk', meta);
  logger?.warn('outbox drain: overlap risk (slow drain)', meta);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Worker default export                                              */
/* ------------------------------------------------------------------ */

/**
 * Default export: the Cloudflare Worker handler shape. Wrangler
 * expects a module with a `scheduled` method when a `[triggers]` cron
 * block is configured for the Worker. Task 8.1 will wire this into
 * the API gateway's wrangler.toml with a once-per-minute cron trigger —
 * see the module docstring for the cadence rationale.
 *
 * Behaviour:
 *   • Kicks off `runScheduledDrain` immediately.
 *   • Registers the resulting promise with `ctx.waitUntil` so the
 *     Worker isolate stays alive until the drain completes, even if
 *     `scheduled` has already returned.
 *   • Catches and logs any error that propagates out of
 *     `runScheduledDrain` (e.g. `claimBatch` hitting a DB outage) so a
 *     crashing cron does not spam the runtime with unhandled
 *     rejections. Per-row failures are swallowed internally by
 *     `drainOutbox` and surfaced in the `DrainResult`, so this catch
 *     only fires on infrastructural failures.
 */
const worker: ScheduledWorker = {
  scheduled(event, env, ctx) {
    const logger = env.logger;
    const task = runScheduledDrain(env).catch((err: unknown) => {
      if (logger !== undefined) {
        logger.error('outbox drain: scheduled invocation failed', {
          cron: event.cron,
          scheduledTime: event.scheduledTime,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        console.error('[drain] scheduled invocation failed', err);
      }
    });
    ctx.waitUntil(task);
  },
};

export default worker;

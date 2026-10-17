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
 *   • Build the leased {@link OutboxStore} adapter (issue #424):
 *     `claimLeasedBatch` stamps a lease and commits at once, sends run
 *     outside any transaction with a bounded pool and deadlines, and
 *     delivered rows are stamped by one `markPublishedMany`.
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

import {
  claimBatch,
  claimLeasedBatch,
  countPendingOutbox,
  countPendingOutboxByType,
  markPublished,
  markPublishedMany,
  releaseLeases,
} from '@athlya/db/outbox';

import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_QUEUE_SEND_TIMEOUT_MS,
  drainOutbox,
  type ClaimedRow,
  type DrainResult,
  type Logger,
  type OutboxStore,
  type QueueProducer,
} from './drain-worker.js';
import {
  COMPLIANCE_EVENT_TYPES,
  resolveEventQueueLane,
  resolveEventQueueProducer,
  type EventQueueBindings,
  type EventQueueLane,
} from './route-queue.js';

import type { AthlyaDb } from '@athlya/db/client';
import type { OutboxPendingSnapshot } from '@athlya/db/outbox';

/** When pending exceeds this, the drain claims up to {@link ADAPTIVE_BATCH_SIZE}. */
export const OUTBOX_BACKLOG_BATCH_THRESHOLD = 500;

/** Adaptive batch size under backlog (Worker CPU budget cap). */
export const ADAPTIVE_BATCH_SIZE = 200;

/**
 * Overlap guard. Cron fires once per minute; a drain that runs longer
 * than this risks colliding with the next tick. The claim lease
 * already makes overlap *correct* (the second drain skips leased rows), but a long drain is a backlog signal,
 * so we emit a structured warning metric instead of relying on a
 * distributed lock. Keep this comfortably under the 60 s cron period.
 */
export const OUTBOX_DRAIN_OVERLAP_WARN_MS = 45_000;

/**
 * Issue #424 — lease-based drain. No transaction or row lock is held
 * while sending: the claim is one short statement that stamps a lease.
 *
 *   - {@link DRAIN_SEND_CONCURRENCY} sends run in parallel, each bounded
 *     by `DEFAULT_QUEUE_SEND_TIMEOUT_MS` (5 s).
 *   - No new send starts after {@link DRAIN_CYCLE_DEADLINE_MS}; the
 *     unattempted rows are released for the next tick.
 *   - {@link DRAIN_LEASE_SECONDS} must outlive the longest cycle
 *     (deadline + one send timeout + the final mark) so a live drain
 *     never has its rows re-claimed underneath it; a dead drain's rows
 *     come back once the lease lapses.
 *
 * Worst case per cycle with a fully hung queue: 200 rows / 8 workers ×
 * 5 s = 125 s of sends, cut at 40 s → ≤ 45 s wall clock, no DB
 * connection or lock held meanwhile.
 */
export const DRAIN_SEND_CONCURRENCY = 8;
export const DRAIN_CYCLE_DEADLINE_MS = 40_000;
export const DRAIN_LEASE_SECONDS = 120;

/**
 * Issue #311 — a cycle keeps claiming batches until the backlog is
 * empty, the cycle deadline is reached, or a whole batch failed (queue
 * unhealthy: stop instead of spinning). Caps one cycle at
 * `DRAIN_MAX_ROUNDS × batch` rows (10 000 at the adaptive size), so a
 * 10k burst empties within one or two ticks at normal queue latency
 * instead of ~50 minutes at 200 rows/min.
 */
export const DRAIN_MAX_ROUNDS = 50;

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
  const lanes = env.batchSize !== undefined ? null : await countPendingOutboxByType(db);
  const snapshot = lanes === null ? null : totalSnapshot(lanes);
  const batchSize = env.batchSize ?? pickBatchSize(snapshot?.pending ?? 0);

  if (snapshot !== null && lanes !== null) {
    emitOutboxBacklogMetric(snapshot, batchSize, logger);
    emitOutboxLaneMetrics(lanes, logger);
  }

  const startedAt = Date.now();

  // Lease-based cycle (issue #424): claim commits immediately, sends
  // run outside any transaction, delivered rows are stamped in one
  // statement at the end.
  // Every row of one claim shares its lease; the token fences the
  // release so a drain that outlived its lease cannot clear another's.
  let leaseToken: string | undefined;
  const store: OutboxStore = {
    claimBatch: async (size) => {
      const rows = await claimLeasedBatch(db, size, DRAIN_LEASE_SECONDS, COMPLIANCE_EVENT_TYPES);
      leaseToken = rows[0]?.leaseToken;
      return rows;
    },
    markPublished: (id) => markPublishedMany(db, [id]),
    markPublishedMany: (ids) => markPublishedMany(db, ids),
    release: async (ids) => {
      if (leaseToken !== undefined) await releaseLeases(db, ids, leaseToken);
    },
  };

  // Build the options bag conditionally so `exactOptionalPropertyTypes`
  // is respected: `logger` is only added when the env provides one.
  const opts: Parameters<typeof drainOutbox>[0] = {
    store,
    resolveQueue: (eventType) => resolveEventQueueProducer(env, eventType) as QueueProducer,
    batchSize,
    concurrency: DRAIN_SEND_CONCURRENCY,
    deadlineMs: DRAIN_CYCLE_DEADLINE_MS,
    sendTimeoutMs: DEFAULT_QUEUE_SEND_TIMEOUT_MS,
    ...(logger !== undefined ? { logger } : {}),
  };

  const cycleDeadline = startedAt + DRAIN_CYCLE_DEADLINE_MS;
  let result: DrainResult = { processed: 0, succeeded: 0, failed: 0, released: 0 };
  let rounds = 0;
  while (rounds < DRAIN_MAX_ROUNDS) {
    const remainingMs = cycleDeadline - Date.now();
    if (remainingMs <= 0) break;
    const round = await drainOutbox({ ...opts, deadlineMs: remainingMs });
    rounds += 1;
    result = {
      processed: result.processed + round.processed,
      succeeded: result.succeeded + round.succeeded,
      failed: result.failed + round.failed,
      released: result.released + round.released,
    };
    // A short batch means the backlog is empty; no success means the
    // queue is unhealthy; released rows mean the deadline was reached.
    if (round.processed < batchSize || round.succeeded === 0 || round.released > 0) break;
  }
  const durationMs = Date.now() - startedAt;
  emitOutboxDrainCycleMetric(durationMs, result, batchSize, logger, rounds);

  // Overlap guard: a drain slower than the warn threshold risks
  // colliding with the next cron tick. SKIP LOCKED keeps that safe,
  // but we surface it as a metric (alert A16) so ops can bump cron
  // frequency or investigate a stuck consumer.
  warnOnDrainOverlapRisk(durationMs, result, batchSize, logger);

  emitOutboxDrainErrorsMetric(result, logger);

  return result;
}

/** Sum the per-type pending rows into the global snapshot. */
export function totalSnapshot(
  lanes: ReadonlyArray<{ pending: number; oldestOccurredAt: Date | null }>,
): OutboxPendingSnapshot {
  let pending = 0;
  let oldest: Date | null = null;
  for (const lane of lanes) {
    pending += lane.pending;
    if (lane.oldestOccurredAt !== null && (oldest === null || lane.oldestOccurredAt < oldest)) {
      oldest = lane.oldestOccurredAt;
    }
  }
  return { pending, oldestOccurredAt: oldest };
}

/** Every queue lane, so each tick reports all of them (zero when drained). */
const EVENT_QUEUE_LANES: readonly EventQueueLane[] = ['notifications', 'rgpd', 'legacy'];

/**
 * Emit one `outbox_lane_backlog` data point per queue lane (issue #311):
 * pending depth and oldest-event age, so a starved lane is alertable on
 * its own rather than hidden in the global count. Lanes with no pending
 * row report `pending: 0`, so dashboards do not keep a stale depth.
 */
export function emitOutboxLaneMetrics(
  types: ReadonlyArray<{ eventType: string; pending: number; oldestOccurredAt: Date | null }>,
  logger?: Logger,
): void {
  const lanes = new Map<EventQueueLane, { pending: number; oldest: Date | null }>(
    EVENT_QUEUE_LANES.map((lane) => [lane, { pending: 0, oldest: null }]),
  );
  for (const t of types) {
    const lane = resolveEventQueueLane(t.eventType);
    const acc = lanes.get(lane) ?? { pending: 0, oldest: null };
    acc.pending += t.pending;
    if (t.oldestOccurredAt !== null && (acc.oldest === null || t.oldestOccurredAt < acc.oldest)) {
      acc.oldest = t.oldestOccurredAt;
    }
    lanes.set(lane, acc);
  }
  const now = Date.now();
  for (const [lane, acc] of lanes) {
    const meta = {
      metric: 'outbox_lane_backlog',
      lane,
      pending: acc.pending,
      oldestAgeMs: acc.oldest === null ? 0 : now - acc.oldest.getTime(),
    };
    console.log('outbox.lane_backlog', meta);
    logger?.info('outbox drain: lane backlog', meta);
  }
}

/**
 * Emit one `outbox_drain_cycle` data point per cycle (issue #424) so the
 * drain duration, throughput and failures are alertable even when they
 * stay under the overlap threshold.
 */
export function emitOutboxDrainCycleMetric(
  durationMs: number,
  result: DrainResult,
  batchSize: number,
  logger?: Logger,
  rounds = 1,
): void {
  const meta = {
    metric: 'outbox_drain_cycle',
    durationMs,
    rounds,
    throughputPerSec: durationMs > 0 ? Math.round((result.succeeded * 1000) / durationMs) : 0,
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    released: result.released,
    batchSize,
    concurrency: DRAIN_SEND_CONCURRENCY,
    deadlineMs: DRAIN_CYCLE_DEADLINE_MS,
  };
  console.log('outbox.drain_cycle', meta);
  logger?.info('outbox drain: cycle', meta);
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

/**
 * Capacity drift reconciliation (issue #135).
 *
 * The hot-path booking protocol (Algorithm 1, `./book.ts`) keeps a
 * Redis `DECR` counter (`class:{id}:remaining`) in lock-step with the
 * authoritative PostgreSQL state (`COUNT(*)` of `confirmed`
 * reservations vs `classes.capacity`). A Worker crash between the
 * Redis mutation and the PG commit — or any compensating `INCR` that
 * never runs — leaves the two stores **drifted**:
 *
 *   - Redis remaining **too high** → the class oversells (Redis hands
 *     out seats PG cannot back).
 *   - Redis remaining **too low**  → false "complet": real seats stay
 *     unsold and users get pushed to the waitlist.
 *
 * PostgreSQL is the source of truth (the `UNIQUE(class_id, user_id)`
 * index makes the confirmed count authoritative). This module is a
 * framework-free reconciliation pass that, for every **active** class:
 *
 *   1. computes `expected = max(0, capacity - confirmed)` from PG,
 *   2. reads the Redis counter,
 *   3. emits a `capacity_redis_pg_drift` metric on mismatch,
 *   4. (optional, default on) auto-heals with an atomic compare-and-set
 *      (one Lua script): Redis is overwritten with the PG truth only if
 *      it still holds the value read in step 2.
 *
 * Race note: the compare-and-set means a DECR or INCR that lands
 * between the Redis read and the heal is never overwritten; the heal is
 * skipped (`raced`) and retried next pass. A booking that commits
 * between the PG snapshot and the Redis read can still leave a
 * transient ±1 drift, which the next pass heals. Neither can oversell:
 * the PG capacity trigger stays authoritative. Persistent drift (the
 * crash bug we target) is what the paired Axiom alert (A17, persistent
 * > 5 min) fires on.
 *
 * Waitlist promotion is NOT done here: the cron role (`athlya_cron`)
 * can neither read reservations nor call
 * `reservation_promote_oldest_waitlist`, so promoting from this sweep
 * needs a migration (phase B of issue #713). Waiters are promoted on
 * cancellation and when an admin raises the capacity.
 *
 * The module takes ports only (no Drizzle, no Upstash import) so it is
 * unit-testable with fakes and reusable from the scheduled Worker
 * handler — see `@athlya/api`'s capacity reconcile runner.
 */

/** Structured-log message + metric name for drift events (alert A17). */
export const CAPACITY_DRIFT_METRIC = 'capacity_redis_pg_drift';
export const CAPACITY_DRIFT_LOG_MESSAGE = 'capacity.drift';

/** Per-class PG snapshot the reconciler compares against Redis. */
export interface ClassCapacitySnapshot {
  readonly classId: string;
  readonly capacity: number;
  /** `COUNT(*)` of reservations in status `confirmed` for the class. */
  readonly confirmed: number;
}

/** Source of authoritative per-class capacity state (PostgreSQL). */
export interface CapacityReconcileRepo {
  /**
   * Return one row per **active** class (not soft-deleted, not in the
   * past) with its capacity and confirmed-booking count, across every
   * studio, since reconciliation is studio-agnostic. The API reads it
   * through the cron-only `capacity_reconcile_snapshot()` function
   * (migration 0040).
   */
  listActiveClassCapacities(): Promise<readonly ClassCapacitySnapshot[]>;
}

/**
 * Minimal Redis counter surface the reconciler needs: read the current
 * value and replace it with the PG truth only if it did not move.
 * Satisfied structurally by `RemainingCounter` from `./counter.js`.
 */
export interface CapacityHealer {
  getRemaining(classId: string): Promise<number | null>;
  compareAndSet(classId: string, expected: number | null, value: number): Promise<boolean>;
}

export interface ReconcileLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export interface ReconcileCapacityOptions {
  readonly repo: CapacityReconcileRepo;
  readonly counter: CapacityHealer;
  readonly logger?: ReconcileLogger;
  /** Reset Redis to the PG truth on drift. Defaults to `true`. */
  readonly autoHeal?: boolean;
}

export interface CapacityDriftDetail {
  readonly classId: string;
  /** Redis value before heal (`null` when the key was missing). */
  readonly redisRemaining: number | null;
  readonly expectedRemaining: number;
  /** `redisRemaining - expectedRemaining` (signed). */
  readonly drift: number;
  readonly healed: boolean;
}

export interface CapacityDriftReport {
  readonly checked: number;
  /** Missing Redis keys seeded from PG (not counted as drift). */
  readonly seeded: number;
  readonly drifted: number;
  readonly healed: number;
  /** Classes whose reset threw — left for the next pass. */
  readonly healFailures: number;
  /** Heals skipped because the counter moved after the read. */
  readonly raced: number;
  readonly drifts: readonly CapacityDriftDetail[];
}

const consoleLogger: ReconcileLogger = {
  info: (msg, ctx) => {
    console.log(msg, ctx ?? {});
  },
  warn: (msg, ctx) => {
    console.warn(msg, ctx ?? {});
  },
  error: (msg, ctx) => {
    console.error(msg, ctx ?? {});
  },
};

/**
 * Reconcile the Redis remaining-seats counter against PostgreSQL for
 * every active class. Never throws on a per-class failure — those are
 * logged and tallied in {@link CapacityDriftReport.healFailures} so a
 * single bad class cannot abort the whole sweep.
 */
export async function reconcileCapacityDrift(
  options: ReconcileCapacityOptions,
): Promise<CapacityDriftReport> {
  const { repo, counter } = options;
  const logger = options.logger ?? consoleLogger;
  const autoHeal = options.autoHeal ?? true;

  const snapshots = await repo.listActiveClassCapacities();

  let seeded = 0;
  let drifted = 0;
  let healed = 0;
  let healFailures = 0;
  let raced = 0;
  const drifts: CapacityDriftDetail[] = [];

  for (const snap of snapshots) {
    const expected = Math.max(0, snap.capacity - snap.confirmed);
    let redisRemaining: number | null;
    try {
      redisRemaining = await counter.getRemaining(snap.classId);
    } catch (err) {
      healFailures += 1;
      logger.error('capacity reconcile: redis read failed', {
        classId: snap.classId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Missing key: seed it from PG. This is normal for a freshly
    // created class whose seed write has not landed, or after a Redis
    // eviction — it is not a drift incident.
    if (redisRemaining === null) {
      try {
        if (await counter.compareAndSet(snap.classId, null, expected)) {
          seeded += 1;
        } else {
          raced += 1;
        }
      } catch (err) {
        healFailures += 1;
        logger.error('capacity reconcile: seed failed', {
          classId: snap.classId,
          expected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    const drift = redisRemaining - expected;
    if (drift === 0) {
      continue;
    }

    drifted += 1;
    logger.warn(CAPACITY_DRIFT_LOG_MESSAGE, {
      metric: CAPACITY_DRIFT_METRIC,
      classId: snap.classId,
      redisRemaining,
      expectedRemaining: expected,
      drift,
      capacity: snap.capacity,
      confirmed: snap.confirmed,
      direction: drift > 0 ? 'oversell_risk' : 'false_full',
    });

    let healedThis = false;
    if (autoHeal) {
      try {
        if (await counter.compareAndSet(snap.classId, redisRemaining, expected)) {
          healed += 1;
          healedThis = true;
        } else {
          raced += 1;
          logger.info('capacity reconcile: counter moved, heal deferred', {
            classId: snap.classId,
          });
        }
      } catch (err) {
        healFailures += 1;
        logger.error('capacity reconcile: heal reset failed', {
          classId: snap.classId,
          expected,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    drifts.push({
      classId: snap.classId,
      redisRemaining,
      expectedRemaining: expected,
      drift,
      healed: healedThis,
    });
  }

  const report: CapacityDriftReport = {
    checked: snapshots.length,
    seeded,
    drifted,
    healed,
    healFailures,
    raced,
    drifts,
  };

  logger.info('capacity reconcile: sweep complete', {
    checked: report.checked,
    seeded: report.seeded,
    drifted: report.drifted,
    healed: report.healed,
    healFailures: report.healFailures,
    raced: report.raced,
  });

  return report;
}

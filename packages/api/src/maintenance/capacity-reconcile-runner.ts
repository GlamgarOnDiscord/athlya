/**
 * Capacity drift reconciliation — scheduled runner (issue #135).
 *
 * Bridges the framework-free {@link reconcileCapacityDrift} sweep onto
 * the Worker `scheduled()` cron handler. The reconciliation needs two
 * I/O surfaces:
 *
 *   • PostgreSQL read across tenants — supplied as the same
 *     `selectRows`-capable cron executor used by the RGPD maintenance
 *     runner (`CRON_DB_URL`, role `athlya_cron`, NOBYPASSRLS). That
 *     role has no grant on `classes` / `reservations`, so the read goes
 *     through the cron-only SECURITY DEFINER function
 *     `capacity_reconcile_snapshot()` (migration 0040, issue #117).
 *   • Redis counter (`class:{id}:remaining`) — the production
 *     `RemainingCounter` from `@athlya/reservations/counter`.
 *
 * Before the drift pass, the runner sweeps seat holds and the waitlist
 * through the cron-only SECURITY DEFINER function
 * `reservation_sweep_holds_and_promote()` (migration 0050, issue #723):
 * expired holds are cancelled and the oldest waiters are promoted into
 * the free seats of upcoming classes, with their `reservation.promoted`
 * events. Running it first lets the same tick heal the Redis counter
 * from the state the promotions leave behind. A failed sweep is logged
 * and the drift pass still runs.
 *
 * Failure isolation matches the RGPD runner: a thrown error is logged
 * and swallowed (never an unhandled rejection on the cron path). The
 * inner per-class isolation lives in {@link reconcileCapacityDrift}.
 */

import {
  reconcileCapacityDrift,
  type CapacityDriftReport,
  type CapacityHealer,
  type CapacityReconcileRepo,
  type ClassCapacitySnapshot,
  type ReconcileLogger,
} from '@athlya/reservations/reconcile';

/** Selector surface shared with the RGPD cron executor. */
export interface CapacityReconcileSqlExecutor {
  selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
}

export interface ScheduledCapacityReconcileDeps {
  readonly executeSql: CapacityReconcileSqlExecutor;
  readonly counter: CapacityHealer;
  readonly logger?: ReconcileLogger;
  /** Override auto-heal (defaults to enabled). */
  readonly autoHeal?: boolean;
}

/**
 * One row per active class (not soft-deleted, not yet started) with its
 * capacity and confirmed count. Past classes carry no meaningful Redis
 * counter, so the function leaves them out; classes with no confirmed
 * booking come back with `confirmed = 0`.
 */
const ACTIVE_CLASS_CAPACITY_SQL = `
  SELECT class_id::text AS "classId",
         capacity::int AS "capacity",
         confirmed::int AS "confirmed"
    FROM capacity_reconcile_snapshot()
`;

/** Expired holds and promotions handled per tick, each; the rest waits a minute. */
export const HOLD_SWEEP_LIMIT = 200;

const HOLD_SWEEP_SQL = `
  SELECT expired_holds::int AS "expiredHolds",
         promoted_waiters::int AS "promotedWaiters",
         promoted_classes::int AS "promotedClasses"
    FROM reservation_sweep_holds_and_promote($1)
`;

/** One sweep of seat holds and the waitlist. */
export interface HoldSweepReport {
  readonly expiredHolds: number;
  readonly promotedWaiters: number;
  readonly promotedClasses: number;
}

/**
 * Cancel expired seat holds and promote waiters into free seats, as
 * `athlya_cron`. Never throws: `null` when the sweep failed (logged).
 */
export async function sweepHoldsAndWaitlist(
  deps: Pick<ScheduledCapacityReconcileDeps, 'executeSql' | 'logger'>,
): Promise<HoldSweepReport | null> {
  try {
    const [report] = await deps.executeSql.selectRows<HoldSweepReport>(HOLD_SWEEP_SQL, [
      HOLD_SWEEP_LIMIT,
    ]);
    const result = report ?? { expiredHolds: 0, promotedWaiters: 0, promotedClasses: 0 };
    (deps.logger?.info ?? console.log)('capacity reconcile: hold and waitlist sweep', {
      ...result,
    });
    return result;
  } catch (err) {
    (deps.logger?.error ?? console.error)('capacity reconcile: hold sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildRepo(executeSql: CapacityReconcileSqlExecutor): CapacityReconcileRepo {
  return {
    async listActiveClassCapacities(): Promise<readonly ClassCapacitySnapshot[]> {
      return executeSql.selectRows<ClassCapacitySnapshot>(ACTIVE_CLASS_CAPACITY_SQL, []);
    },
  };
}

export async function runScheduledCapacityReconcile(
  deps: ScheduledCapacityReconcileDeps,
): Promise<CapacityDriftReport | { readonly skipped: true; readonly reason: string }> {
  await sweepHoldsAndWaitlist(deps);
  try {
    const report = await reconcileCapacityDrift({
      repo: buildRepo(deps.executeSql),
      counter: deps.counter,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.autoHeal !== undefined ? { autoHeal: deps.autoHeal } : {}),
    });
    return report;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    (deps.logger?.error ?? console.error)('capacity reconcile: sweep threw', { error: reason });
    return { skipped: true, reason };
  }
}

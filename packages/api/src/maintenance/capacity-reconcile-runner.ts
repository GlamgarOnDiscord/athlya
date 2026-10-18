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

/**
 * Capacity drift reconciliation — scheduled runner (issue #135).
 *
 * Bridges the framework-free {@link reconcileCapacityDrift} sweep onto
 * the Worker `scheduled()` cron handler. The reconciliation needs two
 * I/O surfaces:
 *
 *   • PostgreSQL read across tenants — supplied as the same
 *     `selectRows`-capable cron executor used by the RGPD maintenance
 *     runner. It must be backed by the `CRON_DB_URL` BYPASSRLS role so
 *     the `COUNT(confirmed)` per class is not clipped by RLS.
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
 * Active classes = not soft-deleted and not yet started. Past classes
 * carry no meaningful Redis counter, so reconciling them would only
 * add noise. `LEFT JOIN` keeps classes with zero confirmed bookings.
 */
const ACTIVE_CLASS_CAPACITY_SQL = `
  SELECT c.id::text AS "classId",
         c.capacity::int AS "capacity",
         COALESCE(r.confirmed, 0)::int AS "confirmed"
    FROM classes c
    LEFT JOIN (
      SELECT class_id, COUNT(*)::int AS confirmed
        FROM reservations
       WHERE status = 'confirmed'
       GROUP BY class_id
    ) r ON r.class_id = c.id
   WHERE c.deleted_at IS NULL
     AND c.starts_at > now()
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

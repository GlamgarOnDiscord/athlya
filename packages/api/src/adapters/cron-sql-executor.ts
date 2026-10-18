/**
 * Cron-only SQL executor.
 *
 * Sprint 13 / Slice 13.2 (Epic SP6.5 + SP7.6 + SP8.3) — wires the
 * `worker.scheduled()` cron handler to its own Neon HTTP client.
 *
 * Why a dedicated executor?
 * ------------------------
 * The cron handler runs cross-tenant maintenance SQL (purge outbox 7d,
 * purge export_jobs 90d, anonymise users J+30, audit anonymisation,
 * capacity drift reconcile) that the tenant-scoped application role
 * `athlya_app` cannot run.
 *
 * The wiring expects a separate connection string `CRON_DB_URL` for
 * `athlya_cron`, which is NOBYPASSRLS (migration 0019). Every statement
 * sent through this executor is admitted by an explicit grant and
 * `*_cron_*` policy (users, outbox, export_jobs) or goes through a
 * cron-only SECURITY DEFINER function (`anonymize_user_audit`,
 * `capacity_reconcile_snapshot`); none depends on BYPASSRLS.
 * `scripts/verify-role-contract.mjs` replays the outbox drain and the
 * capacity snapshot as the real role. The maintenance SQL itself is
 * checked statically by the "cron executor statements need no
 * BYPASSRLS" test in `service-functions.test.ts`, and its policies by
 * the `cron_role.sql` pgTAP suite.
 *
 * If `CRON_DB_URL` is missing the executor returns `null` so the
 * scheduled runner can skip the cycle gracefully — the maintenance
 * is best-effort, not request-critical.
 *
 * Driver constraint
 * -----------------
 * `@neondatabase/serverless` HTTP driver supports parametrised
 * queries via tagged-template syntax OR via the array-of-statements
 * transaction. We use the tagged-template form here, falling back
 * to the more verbose `query()` API when the binding shape demands
 * positional `$1` placeholders (the `rgpd-purge.ts` and
 * `audit-anonymize.ts` modules expect this).
 */

import { createNeonHttpSql } from '@athlya/db';

/** Shape produced by this executor. Matches both
 *  {@link import('../maintenance/rgpd-purge.js').SqlExecutor} and the
 *  selectRows surface required by `audit-anonymize.ts`. */
export interface CronSqlExecutor {
  /**
   * Execute a write/DDL statement. Returns the affected row count
   * (Neon HTTP exposes `rowCount` on every response).
   */
  execute(query: string, params: readonly unknown[]): Promise<number>;
  /**
   * Execute a read statement and return the rows. Generic on the
   * row shape so the caller can narrow without a runtime cast.
   */
  selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]>;
}

/**
 * Build the cron SQL executor from a connection string. Returns
 * `null` when the input is empty / undefined so the caller can
 * `if (executor === null) return earlyExit;`.
 */
export function buildCronSqlExecutor(connectionString: string | undefined): CronSqlExecutor | null {
  if (connectionString === undefined || connectionString.length === 0) {
    return null;
  }

  const sql = createNeonHttpSql(connectionString);

  return {
    async execute(query, params) {
      // `sql(query, params)` returns the row array directly
      // for SELECT, and an array-with-rowCount-property for
      // write statements. Narrow defensively.
      const result = (await sql(query, params)) as {
        readonly rowCount?: number;
        readonly length?: number;
      };
      return typeof result.rowCount === 'number' ? result.rowCount : (result.length ?? 0);
    },
    async selectRows<T>(query: string, params: readonly unknown[]): Promise<T[]> {
      const result = (await sql(query, params)) as T[];
      return result;
    },
  };
}

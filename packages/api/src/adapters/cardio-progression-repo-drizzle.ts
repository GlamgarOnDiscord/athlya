/**
 * Drizzle-backed `CardioProgressionRepo` for
 * `@athlya/members/cardio-progression` (issue #683).
 *
 * Reads only `started_at` and `cardio` of the caller's
 * `workout_sessions` rows that carry a cardio summary, in `[from, to)`,
 * newest first. The statement runs inside `withTenantHttp`, so the
 * `workout_sessions_read_own` RLS policy (`user_id = app_user_id()`)
 * scopes it to the caller even if the explicit `user_id` filter were
 * dropped; the filter stays so the planner walks
 * `workout_sessions_user_started_at_desc_idx` and filters `cardio` on
 * the bounded window (at most one year of the caller's sessions).
 *
 * `started_at` is formatted in SQL as an ISO 8601 UTC string so the
 * shape does not depend on the driver's timestamp parser. `cardio` is
 * decoded like Drizzle's jsonb column (a driver that hands back the raw
 * text gets it parsed) and re-validated by the aggregator.
 */

import { withTenantHttp } from '@athlya/db';
import { sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { CardioProgressionRepo, CardioSessionRow } from '@athlya/members';

interface CardioRow {
  started_at: unknown;
  cardio: unknown;
}

/** Mirror of Drizzle's `PgJsonb.mapFromDriverValue`. */
function decodeJsonb(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function rowsOf(result: unknown): readonly CardioRow[] {
  const rows: unknown = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as readonly CardioRow[]) : [];
}

export function createDrizzleCardioProgressionRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): CardioProgressionRepo {
  return {
    async listCardioInWindow(userId, { from, to, limit }) {
      const result: unknown = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.execute(sql`
            SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
                   cardio
              FROM workout_sessions
             WHERE user_id = ${userId}::uuid
               AND started_at >= ${from.toISOString()}::timestamptz
               AND started_at < ${to.toISOString()}::timestamptz
               AND cardio IS NOT NULL
             ORDER BY started_at DESC
             LIMIT ${limit}
          `),
        ),
      );
      return rowsOf(result).map((row): CardioSessionRow => ({
        startedAt: row.started_at,
        cardio: decodeJsonb(row.cardio),
      }));
    },
  };
}

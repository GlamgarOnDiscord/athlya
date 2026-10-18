/**
 * Drizzle-backed `ProgressionRepo` for `@athlya/members/progression`
 * (task 22.1).
 *
 * Reads the caller's `workout_sessions` rows in `[from, to)`, newest
 * first, over the Neon HTTP driver. The query runs inside
 * `withTenantHttp`, so the `workout_sessions_read_own` RLS policy
 * (`user_id = app_user_id()`) scopes it to the caller even if the
 * explicit `user_id` filter were dropped; the filter stays so the
 * planner uses `workout_sessions_user_started_at_desc_idx`.
 *
 * The handle comes from `getOrCreateDbHttpForRegion`, so EU traffic
 * reads from the Neon EU read replica when `DB_URL_EU` is set (CN.8.3).
 * A replica lags the primary by a few hundred milliseconds at most,
 * which is fine for a trend view.
 *
 * Rows are mapped to the `WorkoutSession` wire shape (ISO strings) and
 * handed back untyped: the aggregator re-validates every row with
 * `WorkoutSessionSchema`.
 */

import { withTenantHttp } from '@athlya/db';
import { workoutSessions } from '@athlya/db/schema';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { WorkoutSessionRow } from '@athlya/db/schema';
import type { ProgressionRepo } from '@athlya/members';

function toWireSession(row: WorkoutSessionRow): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.userId,
    studioId: row.studioId,
    startedAt: row.startedAt.toISOString(),
    durationMin: row.durationMin,
    exercises: row.exercises,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleProgressionRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): ProgressionRepo {
  return {
    async listInWindow(userId, { from, to, limit }) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select()
            .from(workoutSessions)
            .where(
              and(
                eq(workoutSessions.userId, userId),
                gte(workoutSessions.startedAt, from),
                lt(workoutSessions.startedAt, to),
              ),
            )
            .orderBy(desc(workoutSessions.startedAt))
            .limit(limit),
        ),
      );
      return rows.map(toWireSession);
    },
  };
}

/**
 * Drizzle-backed `WorkoutSessionRepo` for `@athlya/members/sessions`
 * (`/v1/sessions/*`, issue #652).
 *
 * RLS posture: every statement runs inside `withTenant` (postgres-js
 * transaction with the caller's `app.*` GUCs) on the write handle, so
 * the owner-only policies of migration 0001 decide what the caller
 * writes and reads: `workout_sessions_insert_own` refuses a row whose
 * `user_id` is not the caller (SQLSTATE 42501) and
 * `workout_sessions_read_own` hides every other member's session, even
 * from an admin. The explicit `user_id` filter of `listByUser` stays so
 * the planner uses `workout_sessions_user_started_at_desc_idx`.
 *
 * Rows are mapped to the `WorkoutSession` wire shape (ISO strings).
 */

import { withTenant } from '@athlya/db/client';
import { workoutSessions } from '@athlya/db/schema';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { WorkoutSessionRow } from '@athlya/db/schema';
import type { WorkoutSessionRepo } from '@athlya/members';
import type { WorkoutSession } from '@athlya/shared/schemas/domain';

export function toWireWorkoutSession(row: WorkoutSessionRow): WorkoutSession {
  return {
    id: row.id as WorkoutSession['id'],
    userId: row.userId as WorkoutSession['userId'],
    studioId: row.studioId as WorkoutSession['studioId'],
    startedAt: row.startedAt.toISOString(),
    durationMin: row.durationMin,
    exercises: row.exercises,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createDrizzleWorkoutSessionRepo(
  db: AthlyaDb,
  claims: TenantClaims,
): WorkoutSessionRepo {
  return {
    async create(input) {
      // Not retried: a connection error after the INSERT reached the
      // server would write the session twice. The client retries with
      // the same Idempotency-Key instead.
      const [row] = await withTenant(db, claims, (tx) =>
        tx
          .insert(workoutSessions)
          .values({
            userId: input.userId,
            studioId: input.studioId ?? null,
            startedAt: new Date(input.startedAt),
            durationMin: input.durationMin ?? null,
            exercises: [...input.exercises],
            notes: input.notes ?? null,
          })
          .returning(),
      );
      if (row === undefined) {
        throw new Error('workout_sessions insert returned no row');
      }
      return toWireWorkoutSession(row);
    },

    async listByUser(userId, { from, to, limit }) {
      const rows = await withConnectionRetry(() =>
        withTenant(db, claims, (tx) =>
          tx
            .select()
            .from(workoutSessions)
            .where(
              and(
                eq(workoutSessions.userId, userId),
                gte(workoutSessions.startedAt, from),
                lt(workoutSessions.startedAt, to),
              ),
            )
            .orderBy(desc(workoutSessions.startedAt), desc(workoutSessions.id))
            .limit(limit),
        ),
      );
      return rows.map(toWireWorkoutSession);
    },
  };
}

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
 * The policies do not constrain `studio_id`, so `create` refuses a
 * studio other than the caller's itself ({@link WorkoutSessionStudioMismatchError}).
 *
 * Idempotency (migration 0044): the request key is stored with the
 * session. A second insert with the same `(user_id, idempotency_key)`
 * hits the partial unique index and does nothing (`ON CONFLICT DO
 * NOTHING`, which waits for a concurrent first insert to commit); the
 * repo then returns the row the first request wrote, so two racing
 * retries can never log the session twice.
 *
 * Imported sessions (migration 0047) follow the same pattern on
 * `(user_id, source, external_id)`: importing a workout that already has
 * a session, under any request key, inserts nothing and returns that
 * session. The insert therefore uses a target-less `ON CONFLICT DO
 * NOTHING`, which covers both partial unique indexes.
 */

import { withTenant } from '@athlya/db/client';
import { workoutSessions } from '@athlya/db/schema';
import { and, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';
import { toWireWorkoutSession } from './workout-session-wire.js';

import type { AthlyaDb, TenantClaims } from '@athlya/db/client';
import type { WorkoutSessionRepo } from '@athlya/members';
import type { SQL } from 'drizzle-orm';

/** `create` was asked to file a session under a studio other than the caller's. */
export class WorkoutSessionStudioMismatchError extends Error {
  public override readonly name = 'WorkoutSessionStudioMismatchError';
  public readonly code = 'studio_mismatch' as const;

  public constructor() {
    super('workout session studioId does not match the caller studio');
  }
}

export function createDrizzleWorkoutSessionRepo(
  db: AthlyaDb,
  claims: TenantClaims,
): WorkoutSessionRepo {
  return {
    async create(input) {
      if (input.studioId !== undefined && input.studioId !== claims.studioId) {
        throw new WorkoutSessionStudioMismatchError();
      }
      const key = input.idempotencyKey ?? null;
      const source = input.source ?? null;
      // Rows an earlier request may have written for this one, most
      // specific first: same request key, then same imported workout.
      const replayMatches: SQL[] = [];
      if (key !== null) {
        replayMatches.push(
          and(
            isNotNull(workoutSessions.idempotencyKey),
            eq(workoutSessions.idempotencyKey, key),
          ) as SQL,
        );
      }
      if (source !== null) {
        replayMatches.push(
          and(
            isNotNull(workoutSessions.externalId),
            eq(workoutSessions.source, source.provider),
            eq(workoutSessions.externalId, source.externalId),
          ) as SQL,
        );
      }
      // Not retried on a connection error: without a key, a retry after
      // the INSERT reached the server would write the session twice.
      // The client retries with the same Idempotency-Key instead.
      return withTenant(db, claims, async (tx) => {
        const [inserted] = await tx
          .insert(workoutSessions)
          .values({
            userId: input.userId,
            studioId: input.studioId ?? null,
            startedAt: new Date(input.startedAt),
            durationMin: input.durationMin ?? null,
            exercises: [...input.exercises],
            notes: input.notes ?? null,
            idempotencyKey: key,
            source: source?.provider ?? null,
            externalId: source?.externalId ?? null,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted !== undefined) {
          return toWireWorkoutSession(inserted);
        }
        if (replayMatches.length === 0) {
          throw new Error('workout_sessions insert returned no row');
        }
        for (const match of replayMatches) {
          const [existing] = await tx
            .select()
            .from(workoutSessions)
            .where(and(eq(workoutSessions.userId, input.userId), match))
            .limit(1);
          if (existing !== undefined) return toWireWorkoutSession(existing);
        }
        throw new Error('workout_sessions idempotency conflict without a visible row');
      });
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

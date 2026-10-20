/**
 * `workout_sessions` row → `WorkoutSession` wire shape (ISO strings),
 * shared by the sessions and progression repos so the shape is defined
 * once. The request idempotency key and the import source (`source`,
 * `external_id`) are internal: they only deduplicate writes and never
 * leave the database. `cardio` is omitted, not `null`, on sessions without
 * one.
 */

import type { WorkoutSessionRow } from '@athlya/db/schema';
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
    ...(row.cardio === null ? {} : { cardio: row.cardio }),
    createdAt: row.createdAt.toISOString(),
  };
}

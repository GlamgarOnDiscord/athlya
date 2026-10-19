/**
 * `workout_sessions` — a member's logged training session.
 *
 * Column choices:
 *   - `studio_id` is nullable because members may record home / outdoor
 *     sessions (Requirement 12.1). RLS for this table therefore scopes on
 *     `user_id = current_setting('app.user_id')` rather than on
 *     `studio_id`.
 *   - `duration_min` is nullable because the mobile UI supports stopping
 *     a session without logging a duration (e.g. paused mid-workout,
 *     user quits before stamping an end).
 *   - `exercises` is a `jsonb` array whose shape is validated at the edge
 *     by `WorkoutSessionSchema` in `@athlya/shared`. Storing the whole
 *     array in one column keeps read latency down on the list view — the
 *     two top queries are "last 30 sessions" (paginated list) and "give
 *     me one full session" (detail screen); both are served without
 *     joining a per-set table.
 *
 * Related requirements: 12.1 (persistence), 12.2 / 12.3 (payload bounds
 * enforced in code), 12.4 (history query shape).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey } from './_shared.js';
import { studios } from './studios.js';
import { users } from './users.js';

import type { CardioMetrics, Exercise } from '@athlya/shared/schemas/domain';

export const workoutSessions = pgTable(
  'workout_sessions',
  {
    id: uuidPrimaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Nullable: home / outdoor sessions have no owning studio. */
    studioId: uuid('studio_id').references(() => studios.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    durationMin: integer('duration_min'),
    /**
     * Typed JSON column. The shape matches `ExerciseSchema[]` from
     * `@athlya/shared`; a strict Zod parse at the API boundary
     * guarantees no invalid payload reaches this column.
     */
    exercises: jsonb('exercises').$type<Exercise[]>().notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
    /**
     * `Idempotency-Key` of the `POST /v1/sessions` request that created
     * the row (migration 0044). Nullable: rows written without a key
     * stay outside the partial unique index.
     */
    idempotencyKey: text('idempotency_key'),
    /**
     * Structured cardio summary of a machine session (migration 0046,
     * issue #667), validated by `CardioMetricsSchema` at the API edge.
     * Nullable: sessions without one, and rows written by older Workers.
     * A CHECK keeps it a JSON object (never a double-encoded string).
     */
    cardio: jsonb('cardio').$type<CardioMetrics>(),
  },
  (table) => [
    /**
     * Requirement 12.4: history endpoint returns sessions ordered by
     * `started_at DESC`. The index stores the descending order
     * natively so the planner can skip an in-memory sort.
     */
    index('workout_sessions_user_started_at_desc_idx').on(
      table.userId,
      sql`${table.startedAt} DESC`,
    ),
    /** A retried log with the same key never inserts a second row. */
    uniqueIndex('workout_sessions_user_idempotency_key_uniq')
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'workout_sessions_cardio_object',
      sql`${table.cardio} IS NULL OR jsonb_typeof(${table.cardio}) = 'object'`,
    ),
  ],
);

export type WorkoutSessionRow = typeof workoutSessions.$inferSelect;
export type WorkoutSessionInsert = typeof workoutSessions.$inferInsert;

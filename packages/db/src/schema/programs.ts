/**
 * Training programs — Epic 24 (tasks 24.1, 24.2), migration 0042.
 *
 *   - `programs`              — a studio's multi-week training plan.
 *   - `program_weeks`         — one row per week of a program (1-based).
 *   - `program_workouts`      — the workout prescribed on one day (1..7)
 *                               of a week; exercises live in a bounded
 *                               `jsonb` array.
 *   - `program_subscriptions` — a user following a program from
 *                               `starts_on`; unsubscribing stamps
 *                               `cancelled_at` so history is kept.
 *
 * Every child table carries `studio_id` and references its parent
 * through the composite `(id, studio_id)` key, so a week, a workout or
 * a subscription can never point at another studio's program. RLS
 * policies (migration 0042) scope every table by `app_studio_id()`.
 *
 * Related requirements: 13.2, 13.6 (tenant isolation), 3.5.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey } from './_shared.js';
import { programStatusEnum } from './enums.js';
import { studios } from './studios.js';
import { users } from './users.js';

/** One exercise of a prescribed workout, as stored in `program_workouts.exercises`. */
export interface ProgramExerciseJson {
  readonly name: string;
  readonly sets: number;
  readonly reps?: number | undefined;
  readonly durationSec?: number | undefined;
  readonly weightKg?: number | undefined;
  readonly restSec?: number | undefined;
  readonly notes?: string | undefined;
}

export const programs = pgTable(
  'programs',
  {
    id: uuidPrimaryKey(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: programStatusEnum('status').notNull().default('draft'),
    /** Optimistic-lock counter bumped by every successful update. */
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('programs_id_studio_unique').on(table.id, table.studioId),
    index('programs_studio_status_idx').on(table.studioId, table.status),
    check('programs_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 120`),
    check(
      'programs_description_length',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 2000`,
    ),
    check(
      'programs_archived_consistency',
      sql`(${table.status} = 'archived') = (${table.archivedAt} IS NOT NULL)`,
    ),
  ],
);

export const programWeeks = pgTable(
  'program_weeks',
  {
    id: uuidPrimaryKey(),
    programId: uuid('program_id').notNull(),
    studioId: uuid('studio_id').notNull(),
    weekNumber: smallint('week_number').notNull(),
    title: text('title'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'program_weeks_program_fk',
      columns: [table.programId, table.studioId],
      foreignColumns: [programs.id, programs.studioId],
    }).onDelete('cascade'),
    unique('program_weeks_id_studio_unique').on(table.id, table.studioId),
    unique('program_weeks_program_week_unique').on(table.programId, table.weekNumber),
    check('program_weeks_week_number_range', sql`${table.weekNumber} BETWEEN 1 AND 52`),
    check(
      'program_weeks_title_length',
      sql`${table.title} IS NULL OR char_length(${table.title}) <= 120`,
    ),
  ],
);

export const programWorkouts = pgTable(
  'program_workouts',
  {
    id: uuidPrimaryKey(),
    weekId: uuid('week_id').notNull(),
    studioId: uuid('studio_id').notNull(),
    dayNumber: smallint('day_number').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    exercises: jsonb('exercises')
      .$type<ProgramExerciseJson[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'program_workouts_week_fk',
      columns: [table.weekId, table.studioId],
      foreignColumns: [programWeeks.id, programWeeks.studioId],
    }).onDelete('cascade'),
    unique('program_workouts_week_day_unique').on(table.weekId, table.dayNumber),
    check('program_workouts_day_number_range', sql`${table.dayNumber} BETWEEN 1 AND 7`),
    check('program_workouts_title_length', sql`char_length(${table.title}) BETWEEN 1 AND 120`),
    check(
      'program_workouts_notes_length',
      sql`${table.notes} IS NULL OR char_length(${table.notes}) <= 2000`,
    ),
    check(
      'program_workouts_exercises_array',
      sql`jsonb_typeof(${table.exercises}) = 'array' AND jsonb_array_length(${table.exercises}) <= 30`,
    ),
  ],
);

export const programSubscriptions = pgTable(
  'program_subscriptions',
  {
    id: uuidPrimaryKey(),
    programId: uuid('program_id').notNull(),
    studioId: uuid('studio_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** First day of the program for this member (day 1 of week 1). */
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    foreignKey({
      name: 'program_subscriptions_program_fk',
      columns: [table.programId, table.studioId],
      foreignColumns: [programs.id, programs.studioId],
    }).onDelete('cascade'),
    /** At most one active subscription per (user, program). */
    uniqueIndex('program_subscriptions_user_program_active_unique')
      .on(table.userId, table.programId)
      .where(sql`cancelled_at IS NULL`),
    index('program_subscriptions_program_idx').on(table.programId),
  ],
);

export type ProgramRow = typeof programs.$inferSelect;
export type ProgramInsert = typeof programs.$inferInsert;
export type ProgramWeekRow = typeof programWeeks.$inferSelect;
export type ProgramWorkoutRow = typeof programWorkouts.$inferSelect;
export type ProgramSubscriptionRow = typeof programSubscriptions.$inferSelect;

/**
 * `classes` — planned sessions in a studio's calendar.
 *
 * Column choices:
 *   - `version INT NOT NULL DEFAULT 0` is the optimistic-lock counter the
 *     admin-side `updateClass` RPC bumps on every successful write
 *     (Requirement 6.6, 6.7). The `UPDATE classes … WHERE id = $1 AND
 *     version = $2` pattern returns zero rows when the admin has stale
 *     state, which the service layer translates to HTTP 409.
 *   - `coach_id` is nullable because a coach may be assigned later or may
 *     leave the studio while historical classes remain visible.
 *   - The composite index `(studio_id, starts_at)` is the single most
 *     important index in the system: every calendar query follows this
 *     shape ("classes for my studio in this date range, ordered by time").
 *
 * Related requirements: 6.1–6.7 (creation and update rules), 7.1 (calendar
 * query shape), 10.1 (referenced by reservations state-machine).
 */

import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey, deletedAt } from './_shared.js';
import { studios } from './studios.js';
import { users } from './users.js';

export const classes = pgTable(
  'classes',
  {
    id: uuidPrimaryKey(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id, { onDelete: 'cascade' }),
    coachId: uuid('coach_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    /**
     * `starts_at` is stored as `timestamptz` with UTC normalisation.
     * The content service rejects past timestamps on creation
     * (Requirement 6.4) but the DB accepts arbitrary values so
     * migrations of historical data remain possible.
     */
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    durationMin: integer('duration_min').notNull(),
    capacity: integer('capacity').notNull(),
    /** Optimistic-lock counter. Every successful UPDATE bumps this. */
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    /**
     * Calendar query accelerator — Requirement 7.1 fetches
     * "classes WHERE studio_id = :s AND starts_at BETWEEN :a AND :b
     * ORDER BY starts_at ASC". This index serves both the predicate
     * and the sort order.
     */
    index('classes_studio_starts_at_idx').on(table.studioId, table.startsAt),
  ],
);

export type ClassRow = typeof classes.$inferSelect;
export type ClassInsert = typeof classes.$inferInsert;

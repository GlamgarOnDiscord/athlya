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

import { sql } from 'drizzle-orm';
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
    /**
     * Room the class runs in (migration 0051). Nullable; the composite
     * FK `classes_room_fk` on `(room_id, studio_id)` keeps it inside the
     * class's studio and is declared in SQL only (Drizzle cannot express
     * its `ON DELETE SET NULL (room_id)` column list).
     */
    roomId: uuid('room_id'),
    /** Groups the occurrences of a weekly series (migration 0051). Nullable. */
    seriesId: uuid('series_id'),
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
    index('classes_id_studio_idx')
      .on(table.id, table.studioId)
      .where(sql`deleted_at IS NULL`),
    /** Overlap lookups behind schedule conflict detection (migration 0051). */
    index('classes_room_starts_at_idx')
      .on(table.roomId, table.startsAt)
      .where(sql`room_id IS NOT NULL AND deleted_at IS NULL`),
    index('classes_coach_starts_at_idx')
      .on(table.coachId, table.startsAt)
      .where(sql`coach_id IS NOT NULL AND deleted_at IS NULL`),
    index('classes_series_starts_at_idx')
      .on(table.seriesId, table.startsAt)
      .where(sql`series_id IS NOT NULL AND deleted_at IS NULL`),
  ],
);

export type ClassRow = typeof classes.$inferSelect;
export type ClassInsert = typeof classes.$inferInsert;

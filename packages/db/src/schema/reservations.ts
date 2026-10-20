/**
 * `reservations` — the per-(user, class) booking record.
 *
 * Column choices:
 *   - `UNIQUE(class_id, user_id) WHERE status IN ('confirmed', 'waitlist')`
 *     is the authoritative anti-double-booking guard (migration 0028). The
 *     partial index excludes cancelled rows so users can re-book a class
 *     after cancelling their reservation (issue #468). Under a race where
 *     two concurrent `bookClass` calls both read capacity and attempt to
 *     insert, PostgreSQL rejects one with a `unique_violation` (23505)
 *     which the service layer catches and converts into an idempotent
 *     success (Requirement 8.4, 8.5).
 *   - `status` uses a dedicated enum (`reservation_status`) rather than a
 *     `CHECK (status IN (...))` text column so the domain invariant is
 *     visible in `pg_catalog` to ops tooling and migrations are safer.
 *   - `cancelled_at` and `checked_in_at` are nullable because they are
 *     stamped by distinct state transitions (Requirements 9.1, 11.6) and
 *     both may legitimately be null for a long-lived `confirmed`
 *     reservation that is attended but never cancelled — or vice-versa.
 *   - `hold_expires_at` (migration 0050, issue #723) is deliberately NOT
 *     declared here. It is set only on `pending` seat holds, which the
 *     holds adapter reads and writes with explicit SQL. Declaring it would
 *     add a `holdExpiresAt` key to every `select()` / `returning()` row
 *     the API sends, and the strict wire `ReservationSchema` already
 *     shipped in mobile clients rejects unknown keys.
 *
 * Related requirements: 8.1–8.6 (booking), 9.1–9.5 (cancellation with
 * waitlist promotion), 10.1–10.5 (state machine), 11.6 (check-in).
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, uuidPrimaryKey } from './_shared.js';
import { classes } from './classes.js';
import { reservationStatusEnum } from './enums.js';
import { users } from './users.js';

export const reservations = pgTable(
  'reservations',
  {
    id: uuidPrimaryKey(),
    classId: uuid('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: reservationStatusEnum('status').notNull(),
    createdAt: createdAt(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    /**
     * The anti-double-booking invariant: at-most-one active
     * reservation per (class, user) pair. Partial on the active
     * statuses only so cancelled rows do not block re-booking
     * (issue #468). Enforced in the database so that even a buggy
     * caller cannot violate it — see Requirement 8.4 and the
     * `UniqueViolation` branch of Algorithm 1 in the design document.
     */
    uniqueIndex('reservations_class_user_active_unique')
      .on(table.classId, table.userId)
      .where(sql`status IN ('confirmed', 'waitlist')`),
    /**
     * Same invariant with seat holds counted (migration 0050): one
     * live row, `confirmed`, `waitlist` or `pending`, per pair. The
     * index above is redundant with it and goes in a contract step.
     */
    uniqueIndex('reservations_class_user_live_unique')
      .on(table.classId, table.userId)
      .where(sql`status NOT IN ('cancelled', 'no_show')`),
    index('reservations_class_status_created_at_idx')
      .on(table.classId, table.status, table.createdAt)
      .where(sql`status = 'waitlist'`),
  ],
);

export type ReservationRow = typeof reservations.$inferSelect;
export type ReservationInsert = typeof reservations.$inferInsert;

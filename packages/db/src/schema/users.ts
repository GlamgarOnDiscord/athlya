/**
 * `users` — the canonical member / coach / admin table.
 *
 * Column choices:
 *   - `email` is a plain `text` column in Drizzle's type system because
 *     `drizzle-orm/pg-core` has no first-class `citext` builder. The
 *     migration `0000_init.sql` (task 2.2) runs
 *     `ALTER TABLE users ALTER COLUMN email TYPE citext` after the
 *     `CREATE EXTENSION citext` step so `UNIQUE(email)` is
 *     case-insensitive by construction. The application keeps
 *     normalising emails to lowercase on the way in for defence in
 *     depth. It is nullable since migration 0041 (issue #628): the RGPD
 *     purge sets it to NULL once a soft-deleted user is past the
 *     retention window. `users_email_live_check` makes live users
 *     (`deleted_at IS NULL`) always hold one; readers drop rows whose
 *     email is NULL instead of asserting it.
 *   - `password_hash` is nullable: OAuth-only accounts (Apple / Google)
 *     never hold a local bcrypt digest. The Auth service (task 3.1)
 *     enforces that either `passwordHash` or a linked provider identity
 *     exists before issuing tokens.
 *   - `consents` is stored as `jsonb` so we can search by flag server-side
 *     (e.g. the Notifications consumer queries `consents->>'marketing'`
 *     before sending a campaign). The shape is validated by
 *     `ConsentsSchema` on every write.
 *   - `users_email_active_unique` is a PARTIAL unique index (WHERE
 *     deleted_at IS NULL). Soft-deleted users' emails are retained until
 *     the 30-day RGPD anonymisation pass sets them to NULL, but during
 *     that window a new user must be able to re-register with the same
 *     address (RGPD Art 17 — right to erasure must not silently prevent
 *     future re-use). The global `users_email_unique` index was dropped
 *     in migration 0026.
 *   - Partial index `(studio_id) WHERE deleted_at IS NULL` accelerates the
 *     admin-side "list my studio's active members" query without bloating
 *     the index with soft-deleted rows.
 *
 * Related requirements: 1.1 (registration), 3.1 (profile), 5.1 (soft
 * delete), 13.2 (tenant isolation), 17.1 (consent gating).
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, sqlIsNull, uuidPrimaryKey } from './_shared.js';
import { userRoleEnum } from './enums.js';
import { studios } from './studios.js';

import type { Consents } from '@athlya/shared/schemas';
import type { StoredNotificationPreferences } from '@athlya/shared/schemas/api';

export const users = pgTable(
  'users',
  {
    id: uuidPrimaryKey(),
    studioId: uuid('studio_id')
      .notNull()
      .references(() => studios.id, { onDelete: 'cascade' }),
    email: text('email'),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    role: userRoleEnum('role').notNull().default('member'),
    /**
     * Versioned consents record. Typed through `$type<Consents>()` so
     * reads land on the strong type defined by `ConsentsSchema`
     * without an intermediate cast. Writes still go through
     * `ConsentsSchema.parse` to prevent shape drift.
     */
    consents: jsonb('consents').$type<Consents>().notNull(),
    /**
     * Channels the member turned off, per message (migration 0054,
     * issue #762). NULL means everything on. Written through
     * `NotificationPreferencesSchema`, read with `isNotificationEnabled`.
     */
    notificationPreferences: jsonb(
      'notification_preferences',
    ).$type<StoredNotificationPreferences>(),
    passwordHash: text('password_hash'),
    /**
     * Monotonic counter incremented on every security-critical event:
     * password reset, logout-all, account deletion, role/studio change.
     * Embedded in access tokens as the `cv` claim; jwtAuth rejects
     * mutation requests whose `cv` is older than the stored value.
     * See issue #520 and migration 0030.
     */
    credentialsVersion: integer('credentials_version').notNull().default(1),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('users_email_active_unique').on(table.email).where(sqlIsNull('deleted_at')),
    /**
     * Partial index on the active (non-deleted) slice. Matches the
     * query shape "list active members in my studio" executed by
     * admins / coaches (Requirement 3.5).
     */
    index('users_studio_active_idx').on(table.studioId).where(sqlIsNull('deleted_at')),
    check(
      'users_email_live_check',
      sql`${table.email} IS NOT NULL OR ${table.deletedAt} IS NOT NULL`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;

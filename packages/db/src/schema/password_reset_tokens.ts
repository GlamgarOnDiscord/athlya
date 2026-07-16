/**
 * `password_reset_tokens` — Sprint 7 / SP7.2 (Vague 35) — finalises
 * audit finding S2-006 (forgot-password flow).
 *
 * Storage layout matches the migration `0005_password_reset_audit_anonymize.sql`:
 *   id           UUID PK            random v7, never exposed.
 *   user_id      UUID FK → users.id ON DELETE CASCADE.
 *   token_hash   TEXT UNIQUE NOT NULL  SHA-256 hex of the plain token; the
 *                                       plain token is NEVER persisted.
 *   expires_at   TIMESTAMPTZ NOT NULL  TTL from `forgot-password.ts`
 *                                       (default 1 h).
 *   consumed_at  TIMESTAMPTZ NULL     stamped on successful confirm. The
 *                                       composite filter
 *                                       `consumed_at IS NULL AND expires_at > NOW()`
 *                                       is the active-token selector.
 *   requested_at TIMESTAMPTZ NOT NULL  forensic timeline.
 *
 * The Drizzle adapter consumed by `forgot-password.ts` lives in
 * `packages/api/src/adapters/password-reset-repo-drizzle.ts`. Tests
 * use the in-memory repo from `forgot-password.test.ts`.
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { sqlIsNull, uuidPrimaryKey } from './_shared.js';
import { users } from './users.js';

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuidPrimaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp('consumed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    requestedAt: timestamp('requested_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Lookup index (also enforces uniqueness — two tokens with
    // the same hash would be a SHA-256 collision, which would
    // be a much bigger problem than a duplicate entry).
    uniqueIndex('password_reset_tokens_token_hash_uq').on(table.tokenHash),
    // User-scoped index for the rate-limit guard ("max 3 reset
    // requests per email per 24h", wired at the route layer)
    // and the GDPR cascade
    // (`DELETE password_reset_tokens WHERE user_id = $1`).
    index('password_reset_tokens_user_idx').on(table.userId),
    // Partial unique index: at most one active (unconsumed) token per
    // user. Consumed tokens are excluded so forensic history is preserved.
    // Mirrors migration 0029; enforces the DB-level boundary for the
    // sibling-invalidation invariant from issue #522.
    uniqueIndex('password_reset_tokens_user_active_uidx')
      .on(table.userId)
      .where(sqlIsNull('consumed_at')),
  ],
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type PasswordResetTokenInsert = typeof passwordResetTokens.$inferInsert;

/**
 * `idempotency_keys` — per-user cache of applied mutation responses.
 *
 * Composite primary key `(key, user_id)` because:
 *   - Requirement 20.1 requires us to return the stored response for a
 *     repeated `Idempotency-Key` header.
 *   - Requirement 20.2 requires a 24-hour retention window.
 *   - Keys are bound to `user_id` so two different users submitting the
 *     same UUID never collide (the mobile client generates UUID v4s which
 *     are astronomically unlikely to collide anyway, but the server
 *     cannot rely on that property for security).
 *
 * The row layout is optimised for the idempotency middleware's only two
 * operations (task 4.2):
 *   1. `SELECT … WHERE key = $1 AND user_id = $2` — served by the primary
 *      key index in a single row fetch.
 *   2. `DELETE … WHERE expires_at <= now()` — served by the
 *      `idempotency_keys_expires_at_idx` index, run by the scheduled
 *      maintenance tick through `idempotency_purge_expired`
 *      (migration 0047, issue #689).
 *
 * Related requirements: 20.1, 20.2.
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt } from './_shared.js';
import { users } from './users.js';

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The serialised HTTP response (body + any headers worth
     * replaying) associated with the original successful call.
     */
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    statusCode: integer('status_code').notNull(),
    createdAt: createdAt(),
    /**
     * Hard TTL. The middleware treats rows past `expires_at` as
     * non-existent even before the sweeper removes them, so clock
     * skew between the sweeper and the gateway cannot serve stale
     * data.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'idempotency_keys_pk',
      columns: [table.key, table.userId],
    }),
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type IdempotencyKeyInsert = typeof idempotencyKeys.$inferInsert;

/**
 * `push_tokens` — Expo Push / APNs / FCM / Web Push registrations.
 *
 * Column choices:
 *   - `token` is globally unique: the Notifications consumer uses the
 *     token string as the routing key, and the same token must never map
 *     to two different users. Expo Push returns a fresh token on reinstall
 *     so this invariant is safe in practice.
 *   - `deleted_at` is the soft-delete flag flipped when a user logs out
 *     from a device, when the platform reports the token as invalid
 *     (`DeviceNotRegistered`), or by the RGPD cascade (Requirement 5.2).
 *
 * Related requirements: 17.1 (push delivery), 5.2 (cascade delete on
 * account deletion).
 */

import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, uuidPrimaryKey } from './_shared.js';
import { pushPlatformEnum } from './enums.js';
import { users } from './users.js';

export const pushTokens = pgTable(
  'push_tokens',
  {
    id: uuidPrimaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: pushPlatformEnum('platform').notNull(),
    token: text('token').notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (table) => [uniqueIndex('push_tokens_token_unique').on(table.token)],
);

export type PushTokenRow = typeof pushTokens.$inferSelect;
export type PushTokenInsert = typeof pushTokens.$inferInsert;

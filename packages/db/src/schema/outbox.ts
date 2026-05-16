/**
 * `outbox` — transactional-outbox buffer for the event bus.
 *
 * Column choices:
 *   - `event_id` is the domain-level event UUID (generated at publish
 *     time by the producing service). It has a `UNIQUE` constraint so a
 *     double-insert triggered by a retry is idempotent — the second
 *     insert fails with `unique_violation` and the caller treats it as a
 *     successful publish.
 *   - `payload` is `jsonb`; the producing service wraps the event in the
 *     discriminated union declared in `@athlya/shared/events` (task 9.1)
 *     before serialising.
 *   - `published_at` is nullable: `NULL` means "still pending, the drain
 *     worker should publish it"; a non-NULL value means "already
 *     delivered, eligible for cleanup". The drain worker (task 9.3) runs
 *     every 30 s, so `attempts` rarely exceeds 2–3 in steady state.
 *
 * Related requirements: 16.1 (publish), 16.2 / 16.3 (outbox fallback),
 * 16.4 (drain worker).
 */

import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, sqlIsNull, uuidPrimaryKey } from './_shared.js';

export const outbox = pgTable(
    'outbox',
    {
        id: uuidPrimaryKey(),
        /** Domain-level event identifier. Unique so retries are safe. */
        eventId: text('event_id').notNull(),
        eventType: text('event_type').notNull(),
        payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
        occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
        publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
        attempts: integer('attempts').notNull().default(0),
        createdAt: createdAt(),
    },
    (table) => [
        uniqueIndex('outbox_event_id_unique').on(table.eventId),
        /**
         * The drain worker's primary query: "give me unpublished events,
         * oldest first". Partial index on the pending slice keeps the
         * index tiny (most rows are `publishedAt IS NOT NULL` after
         * delivery, which itself is cleaned up periodically).
         */
        index('outbox_pending_idx').on(table.occurredAt).where(sqlIsNull('published_at')),
    ],
);

export type OutboxRow = typeof outbox.$inferSelect;
export type OutboxInsert = typeof outbox.$inferInsert;

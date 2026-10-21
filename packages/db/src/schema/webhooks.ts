/**
 * `webhook_endpoints` and `webhook_deliveries` (migration 0053, issue #760).
 *
 * An admin registers HTTPS endpoints for event types. A trigger on
 * `outbox` records one delivery per subscribed endpoint; the cron claims
 * and posts them through `webhook_claim_deliveries` and
 * `webhook_record_attempt`.
 *
 * Left out of these definitions on purpose, because athlya_app has no
 * SELECT on them: `webhook_endpoints.secret` (the HMAC key, written by
 * the API and read only by the cron claim) and
 * `webhook_deliveries.payload`, `lease_until`.
 */

import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { uuidPrimaryKey } from './_shared.js';
import { studios } from './studios.js';
import { users } from './users.js';

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuidPrimaryKey(),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuidPrimaryKey(),
  endpointId: uuid('endpoint_id')
    .notNull()
    .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
  studioId: uuid('studio_id')
    .notNull()
    .references(() => studios.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
});

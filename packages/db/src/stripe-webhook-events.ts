/**
 * Stripe webhook event deduplication (issue #69).
 *
 * `claimStripeWebhookEvent` inserts `event_id` once. A duplicate delivery
 * returns `false` so the handler can ack 200 without re-publishing.
 */

import { sql } from 'drizzle-orm';

import type { AthlyaDb } from './client.js';

interface InsertRow {
  event_id: string;
  [key: string]: unknown;
}

/**
 * @returns `true` when this `eventId` is new; `false` when already processed.
 */
export async function claimStripeWebhookEvent(
  db: AthlyaDb,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  if (eventId.length === 0 || eventType.length === 0) {
    return false;
  }

  const result = await db.execute<InsertRow>(sql`
        INSERT INTO stripe_webhook_events (event_id, event_type)
        VALUES (${eventId}, ${eventType})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
    `);

  const rows = result as unknown as readonly InsertRow[];
  return rows.length > 0;
}

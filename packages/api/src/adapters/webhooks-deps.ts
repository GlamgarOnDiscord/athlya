/**
 * Webhook endpoints adapter (issue #760). Every statement runs under the
 * caller's claims: the `webhook_endpoints_admin_*` and
 * `webhook_deliveries_admin_read` policies of migration 0055 scope it to
 * the admins of the studio. The signing secret is written here and never
 * read back (athlya_app has no SELECT on the column).
 */

import { withTenant } from '@athlya/db/client';
import { webhookDeliveries, webhookEndpoints } from '@athlya/db/schema';
import { and, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { MAX_WEBHOOK_ENDPOINTS } from '../routes/webhooks.js';

import { getOrCreateWriteDb } from './deps-cache.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { WebhooksDeps } from '../routes/webhooks.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDb, AthlyaTx, TenantClaims } from '@athlya/db/client';
import type {
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventType,
} from '@athlya/shared/schemas/api';

/**
 * Write view of `webhook_endpoints` with the `secret` column, which the
 * shared table definition leaves out (athlya_app may write it, never read
 * it). Used for INSERT and UPDATE only, returning the id alone.
 */
const endpointWrites = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  studioId: uuid('studio_id').notNull(),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secret: text('secret').notNull(),
  enabled: boolean('enabled').notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** Deliveries listed per endpoint, newest first. */
export const RECENT_DELIVERIES = 10;

function toTenantClaims(claims: AuthClaims): TenantClaims {
  return { userId: claims.userId, studioId: claims.studioId, role: claims.role };
}

const endpointColumns = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  enabled: webhookEndpoints.enabled,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
};

type EndpointRow = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

async function recentDeliveries(
  tx: AthlyaTx,
  endpointIds: readonly string[],
): Promise<Map<string, WebhookDelivery[]>> {
  const byEndpoint = new Map<string, WebhookDelivery[]>();
  if (endpointIds.length === 0) return byEndpoint;
  // Rank inside each endpoint so a busy endpoint cannot crowd the others
  // out of a single global LIMIT.
  const ranked = tx
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastStatusCode: webhookDeliveries.lastStatusCode,
      lastError: webhookDeliveries.lastError,
      createdAt: webhookDeliveries.createdAt,
      deliveredAt: webhookDeliveries.deliveredAt,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      rank: sql<number>`row_number() OVER (PARTITION BY ${webhookDeliveries.endpointId} ORDER BY ${webhookDeliveries.createdAt} DESC, ${webhookDeliveries.id} DESC)`.as(
        'rank',
      ),
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.endpointId, [...endpointIds]))
    .as('ranked');
  const rows = await tx
    .select()
    .from(ranked)
    .where(lte(ranked.rank, RECENT_DELIVERIES))
    .orderBy(desc(ranked.createdAt), desc(ranked.id));
  for (const row of rows) {
    const list = byEndpoint.get(row.endpointId) ?? [];
    const status =
      row.status === 'delivered' || row.status === 'failed' ? row.status : ('pending' as const);
    list.push({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      status,
      attempts: row.attempts,
      lastStatusCode: row.lastStatusCode,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
      nextAttemptAt: status === 'pending' ? row.nextAttemptAt.toISOString() : null,
    });
    byEndpoint.set(row.endpointId, list);
  }
  return byEndpoint;
}

function toEndpoint(row: EndpointRow, deliveries: WebhookDelivery[]): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events as WebhookEventType[],
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    recentDeliveries: deliveries,
  };
}

async function readEndpoint(tx: AthlyaTx, id: string): Promise<WebhookEndpoint | null> {
  const [row] = await tx
    .select(endpointColumns)
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .limit(1);
  if (row === undefined) return null;
  const deliveries = await recentDeliveries(tx, [row.id]);
  return toEndpoint(row, deliveries.get(row.id) ?? []);
}

/** Webhooks repository over a postgres-js handle; exported for the PGlite tests. */
export function createWebhooksRepo(db: AthlyaDb): WebhooksDeps {
  return {
    async listEndpoints(claims) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const rows = await tx
          .select(endpointColumns)
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.studioId, claims.studioId))
          .orderBy(webhookEndpoints.createdAt, webhookEndpoints.id);
        const deliveries = await recentDeliveries(
          tx,
          rows.map((row) => row.id),
        );
        return rows.map((row) => toEndpoint(row, deliveries.get(row.id) ?? []));
      });
    },

    async createEndpoint(claims, input) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const [existing] = await tx
          .select({ n: count() })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.studioId, claims.studioId));
        if ((existing?.n ?? 0) >= MAX_WEBHOOK_ENDPOINTS) return null;
        const [row] = await tx
          .insert(endpointWrites)
          .values({
            studioId: claims.studioId,
            url: input.url,
            events: [...input.events],
            secret: input.secret,
            enabled: true,
            createdBy: claims.userId,
          })
          .returning({ id: endpointWrites.id });
        if (row === undefined) throw new Error('webhook endpoint insert returned no id');
        return readEndpoint(tx, row.id);
      });
    },

    async updateEndpoint(claims, id, patch) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const set: Partial<typeof endpointWrites.$inferInsert> = { updatedAt: new Date() };
        if (patch.url !== undefined) set.url = patch.url;
        if (patch.events !== undefined) set.events = [...patch.events];
        if (patch.enabled !== undefined) set.enabled = patch.enabled;
        if (patch.secret !== undefined) set.secret = patch.secret;
        const [row] = await tx
          .update(endpointWrites)
          .set(set)
          .where(and(eq(endpointWrites.id, id), eq(endpointWrites.studioId, claims.studioId)))
          .returning({ id: endpointWrites.id });
        return row === undefined ? null : readEndpoint(tx, row.id);
      });
    },

    async deleteEndpoint(claims, id) {
      return withTenant(db, toTenantClaims(claims), async (tx) => {
        const rows = await tx
          .delete(webhookEndpoints)
          .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.studioId, claims.studioId)))
          .returning({ id: webhookEndpoints.id });
        return rows.length > 0;
      });
    },
  };
}

export function buildWebhooksDeps(env: AthlyaBindings): WebhooksDeps {
  const repo = (): WebhooksDeps => createWebhooksRepo(getOrCreateWriteDb(env));
  return {
    listEndpoints: (claims) => repo().listEndpoints(claims),
    createEndpoint: (claims, input) => repo().createEndpoint(claims, input),
    updateEndpoint: (claims, id, patch) => repo().updateEndpoint(claims, id, patch),
    deleteEndpoint: (claims, id) => repo().deleteEndpoint(claims, id),
  };
}

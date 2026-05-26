/**
 * Drizzle-backed `DeletionRepo` for `@athlya/members/cascade`.
 *
 * Backs the RGPD Article 17 cascade exposed by
 * {@link import('@athlya/members').handleUserDeleted}. The cascade
 * is invoked by the Worker `queue()` consumer when an
 * `auth.user.deleted` event lands on the main queue (see
 * {@link import('../worker.js')}); this adapter is the bridge
 * between that service-layer port and the live Postgres tables.
 *
 * Idempotency
 * -----------
 * Every method maps to one `DELETE … WHERE user_id = $1` (or the
 * audit-log anonymisation equivalent). PostgreSQL silently matches
 * zero rows when the cascade is re-played after a partial failure,
 * which is exactly the contract the cascade orchestrator relies on
 * (Req 5.4 + Cloudflare Queues at-least-once redelivery). No
 * transactional envelope is needed — the cascade orchestrator
 * documents that each repo call commits independently.
 *
 * Driver flavour
 * --------------
 * Uses {@link AthlyaDbAny} so this adapter accepts both the
 * postgres-js handle and the HTTP-driver one. The cascade does NOT
 * open an interactive `db.transaction(async tx => …)` so the HTTP
 * driver is a strict upgrade — see `auth-deps.ts`/`members-deps.ts`
 * for the same rationale.
 *
 * Slice 1.3 — Sprint 1 — resolves audit finding S5-002 (CRITICAL
 * RGPD Article 17 cascade not wired). See `docs/security/audit-S5-rgpd.md`.
 */

import {
  auditLog,
  idempotencyKeys,
  pushTokens,
  reservations,
  users,
  workoutSessions,
} from '@athlya/db/schema';
import { eq, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type { DeletionRepo } from '@athlya/members';

/**
 * Factory — produces a `DeletionRepo` bound to the supplied Drizzle
 * instance. One per request (Workers I/O isolation), no long-lived
 * state.
 */
export function createDrizzleDeletionRepo(db: AthlyaDbAny): DeletionRepo {
  return {
    async deleteReservationsForUser(userId) {
      const rows = await withConnectionRetry(() =>
        db.delete(reservations).where(eq(reservations.userId, userId)).returning(),
      );
      return rows.length;
    },

    async deleteWorkoutSessionsForUser(userId) {
      const rows = await withConnectionRetry(() =>
        db.delete(workoutSessions).where(eq(workoutSessions.userId, userId)).returning(),
      );
      return rows.length;
    },

    async deletePushTokensForUser(userId) {
      // Hard delete — the cascade docstring is explicit. The
      // schema's `deleted_at` soft-delete column is for the
      // notifications consumer's own bookkeeping (token marked
      // invalid by the platform) and is not the right tombstone
      // for a fully-erased user.
      const rows = await withConnectionRetry(() =>
        db.delete(pushTokens).where(eq(pushTokens.userId, userId)).returning(),
      );
      return rows.length;
    },

    async deleteIdempotencyKeysForUser(userId) {
      const rows = await withConnectionRetry(() =>
        db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId)).returning(),
      );
      return rows.length;
    },

    async markUserDeleted(userId, deletedAt) {
      // Idempotent: the Auth service already stamped `deleted_at`
      // when it published the event (Req 5.1), so this `UPDATE`
      // typically matches one row already carrying a tombstone.
      // Re-stamping with the cascade's clock keeps the value
      // monotonically up-to-date if the cascade is replayed.
      await withConnectionRetry(async () => {
        await db.update(users).set({ deletedAt }).where(eq(users.id, userId));
      });
    },

    async anonymizeAuditRows(userId) {
      // Single statement matching the SQL in the cascade
      // module's docblock. The PII keys stripped from the
      // `metadata` JSONB are intentionally enumerated here
      // (rather than wholesale-replacing `metadata`) so an
      // operator audit-trail keeps non-PII fields like
      // `subjectUserId`, `eventType`, `revision` for forensics
      // (Req 5.3). See finding S5-017 in the audit for the
      // ongoing controversy on `subjectUserId`.
      const result = await withConnectionRetry(() =>
        db
          .update(auditLog)
          .set({
            actorId: null,
            metadata: sql`COALESCE(${auditLog.metadata}, '{}'::jsonb) - 'email' - 'displayName' - 'ip' - 'userAgent'`,
          })
          .where(eq(auditLog.actorId, userId))
          .returning(),
      );
      return result.length;
    },
  };
}

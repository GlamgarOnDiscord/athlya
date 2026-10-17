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
 * RLS posture (issues #224, #117)
 * --------------------------------
 * The queue consumer runs as `athlya_app` with no tenant claims, so the
 * purge goes through the `rgpd_delete_*` (migration 0032),
 * `rgpd_confirm_user_deleted` (migration 0037) and
 * `rgpd_anonymize_user_audit` (migration 0039) SECURITY DEFINER
 * functions. They only act on a user
 * whose `deleted_at` is already set, so a forged or replayed event
 * cannot erase a live account.
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

import { callCount, queryRows, serviceFn } from './service-functions.js';

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
      return callCount(db, serviceFn.deleteReservations(userId));
    },

    async deleteWorkoutSessionsForUser(userId) {
      return callCount(db, serviceFn.deleteWorkoutSessions(userId));
    },

    async deletePushTokensForUser(userId) {
      // Hard delete — the cascade docstring is explicit. The
      // schema's `deleted_at` soft-delete column is for the
      // notifications consumer's own bookkeeping (token marked
      // invalid by the platform) and is not the right tombstone
      // for a fully-erased user.
      return callCount(db, serviceFn.deletePushTokens(userId));
    },

    async deleteIdempotencyKeysForUser(userId) {
      return callCount(db, serviceFn.deleteIdempotencyKeys(userId));
    },

    async markUserDeleted(userId) {
      // The Auth service stamped `deleted_at` when it published the
      // event (Req 5.1). Read-only confirmation (migration 0037, issue
      // #609): the original tombstone is kept so a replayed or re-queued
      // event never restarts the retention clock, and a live account is
      // never tombstoned.
      const rows = await queryRows<{ deleted: boolean }>(db, serviceFn.confirmUserDeleted(userId));
      return rows[0]?.deleted === true;
    },

    async anonymizeAuditRows(userId) {
      // `audit_log` is append-only for athlya_app (no UPDATE grant,
      // `audit_no_update` USING false). The only sanctioned mutation is
      // `anonymize_user_audit()` (migrations 0003/0006): actor_id → NULL
      // and the PII keys stripped from `metadata`, for rows the user
      // acted on or is the subject of. `rgpd_anonymize_user_audit`
      // (migration 0039) exposes it to the cascade, as a no-op for a
      // live account. Idempotent, so a redelivered event is harmless.
      return callCount(db, serviceFn.anonymizeUserAudit(userId));
    },
  };
}

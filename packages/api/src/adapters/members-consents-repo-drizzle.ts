/**
 * Drizzle-backed `ConsentsRepo` for `@athlya/members/consents`.
 *
 * The consents record is stored inline on the `users` row as a
 * `jsonb` column (see `packages/db/src/schema/users.ts`). Read and
 * write flow through that single column; there is no separate
 * `consents` table because the `version` + `updatedAt` metadata is
 * itself part of the JSON shape.
 *
 * Contract mapping:
 *   - {@link ConsentsRepo.findConsents} — `SELECT consents FROM users
 *     WHERE id = $1 AND deleted_at IS NULL LIMIT 1`. Returns `null`
 *     when the row is missing or soft-deleted, matching the
 *     service's NEVER_ACCEPTED fallback posture.
 *   - {@link ConsentsRepo.updateConsents} — `UPDATE users SET
 *     consents = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING
 *     consents`. The service has already stamped `version` and
 *     `updatedAt`; the repo merely echoes the stored row back so
 *     the caller observes the canonical value after the write.
 *
 * @see Requirements 3.3, 17.1.
 */

import { withTenantHttp } from '@athlya/db';
import { users } from '@athlya/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny, AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { ConsentsRepo } from '@athlya/members';

/**
 * Factory — produces a `ConsentsRepo` bound to the supplied Drizzle
 * instance. Per-request in production (Cloudflare Workers I/O
 * isolation) so no long-lived state.
 */
export function createDrizzleConsentsRepo(db: AthlyaDbAny): ConsentsRepo {
  return {
    async findConsents(userId) {
      const rows = await withConnectionRetry(() =>
        db
          .select({ consents: users.consents })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .limit(1),
      );
      const row = rows[0];
      return row === undefined ? null : row.consents;
    },

    async updateConsents(userId, consents) {
      const [row] = await withConnectionRetry(() =>
        db
          .update(users)
          .set({ consents })
          .where(and(eq(users.id, userId), isNull(users.deletedAt)))
          .returning(),
      );
      if (row === undefined) {
        // Row disappeared between the service's check and our
        // write — surface as a plain error so the gateway's
        // fallback 500 branch handles it. The consents service
        // does not have a `not_found` error code for writes
        // (only reads), and an aborted soft-delete race is a
        // genuinely exceptional condition, not a user-facing
        // 4xx.
        throw new Error(`updateConsents: user ${userId} not found or soft-deleted`);
      }
      return row.consents;
    },
  };
}

/**
 * HTTP-driver variant — each query runs inside a `withTenantHttp`
 * batch so `SET LOCAL app.*` activates RLS policies before the
 * business statement executes.
 */
export function createDrizzleConsentsRepoHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): ConsentsRepo {
  return {
    async findConsents(userId) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select({ consents: users.consents })
            .from(users)
            .where(and(eq(users.id, userId), isNull(users.deletedAt)))
            .limit(1),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : row.consents;
    },

    async updateConsents(userId, consents) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(users)
            .set({ consents })
            .where(and(eq(users.id, userId), isNull(users.deletedAt)))
            .returning(),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`updateConsents: user ${userId} not found or soft-deleted`);
      }
      return row.consents;
    },
  };
}

/**
 * Drizzle-backed `PasswordResetRepo` adapter — Sprint 7 / SP7.3
 * (Vague 35) — finalises audit finding S2-006.
 *
 * Implements the contract exported by
 * `@athlya/auth/forgot-password.ts`:
 *
 *   - `insertToken({ userId, tokenHash, expiresAt })` — single-row
 *     INSERT. The plain token is NEVER seen by this adapter.
 *   - `findActiveTokenByHash(tokenHash)` — SELECT with the active
 *     filter `consumed_at IS NULL AND expires_at > NOW()`.
 *   - `consumeAndResetPassword({ tokenHash, userId, newPasswordHash })`
 *     — atomic transaction: stamp `consumed_at = NOW()` AND update
 *     the user's `password_hash`. Both writes succeed or neither
 *     does.
 *
 * Idempotence: re-presenting the same token twice fails the second
 * time because the row's `consumed_at` is now non-null and the
 * UPDATE matches zero rows. The error surfaces upstream via the
 * `findActiveTokenByHash` returning `null` on the next attempt —
 * `forgot-password.ts::confirmReset` raises `token_invalid` from
 * that null.
 *
 * Rate limit at the route layer (deferred — see SP7.4) caps the
 * insert path; this adapter does NOT enforce it.
 *
 * @see packages/db/migrations/0005_password_reset_audit_anonymize.sql
 * @see packages/auth/src/forgot-password.ts
 */

import { passwordResetTokens } from '@athlya/db/schema';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { PasswordResetRepo } from '@athlya/auth';
import type { AthlyaDbHttp } from '@athlya/db/client';

/**
 * Build the Drizzle-backed adapter. The factory is per-isolate
 * (binds the `db` handle) and stateless beyond that — no caching
 * inside the closure.
 *
 * neon-http-norls: password_reset_tokens has no tenant-scoped RLS policy;
 * the flow runs pre-authentication so no TenantClaims are available.
 */
export function createDrizzlePasswordResetRepo(db: AthlyaDbHttp): PasswordResetRepo {
  return {
    async insertToken(input) {
      // Atomically invalidate any existing active tokens for this user
      // before inserting the new one. The CTE and the INSERT run in the
      // same server-side statement so no concurrent request can slip a
      // second active token in between the invalidation and the insert.
      // The partial unique index `password_reset_tokens_user_active_uidx`
      // (migration 0029) is the DB-level safety net for the narrow window
      // where two concurrent issuance requests reach the DB simultaneously.
      await withConnectionRetry(() =>
        db.execute(sql`
          WITH invalidated AS (
            UPDATE password_reset_tokens
            SET    consumed_at = NOW()
            WHERE  user_id     = ${input.userId}::uuid
              AND  consumed_at IS NULL
          )
          INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
          VALUES (${input.userId}::uuid, ${input.tokenHash}, ${input.expiresAt.toISOString()}::timestamptz)
        `),
      );
    },

    async findActiveTokenByHash(tokenHash) {
      // Active = not consumed AND not expired. The SQL filter
      // is the security boundary — even if the in-memory
      // expiry guard in `confirmReset` had a clock skew, this
      // SELECT guarantees we never return a stale row.
      const rows = await withConnectionRetry(() =>
        db
          .select({
            userId: passwordResetTokens.userId,
            expiresAt: passwordResetTokens.expiresAt,
          })
          .from(passwordResetTokens)
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash),
              isNull(passwordResetTokens.consumedAt),
              gt(passwordResetTokens.expiresAt, new Date()),
            ),
          )
          .limit(1),
      );

      if (rows.length === 0) return null;
      const row = rows[0]!;
      return {
        userId: row.userId,
        expiresAt: row.expiresAt,
      };
    },

    async consumeAndResetPassword(input) {
      // Atomic CTE: stamps consumed_at on the presented token, invalidates
      // all sibling active tokens for the same user, then updates the
      // password — all in one server-side statement (issue #522).
      //
      // CTE execution order:
      //   1. `target` — marks the presented token consumed.  Returns its
      //      user_id + id so downstream CTEs can reference it.  Returns
      //      zero rows when the token was already consumed or belongs to a
      //      different user; in that case the whole statement is a no-op.
      //   2. `siblings` — marks every other active token for the same user
      //      consumed.  The FROM join against `target` means this runs only
      //      when step 1 matched a row.  Data-modifying CTEs execute even
      //      when their output is not referenced by the final SELECT.
      //   3. `updated` — updates the password.  Also gated on `target`.
      //
      // Concurrent confirmation race: if two requests present different
      // tokens for the same user concurrently, the first UPDATE to commit
      // wins (its consumed_at IS NULL guard succeeds); the second UPDATE
      // finds the row already consumed and returns 0 rows → the CTE is a
      // no-op → the password is not double-updated.
      const result = await withConnectionRetry(() =>
        db.execute<{ id: string }>(sql`
          WITH target AS (
            UPDATE password_reset_tokens
            SET    consumed_at = NOW()
            WHERE  token_hash  = ${input.tokenHash}
              AND  consumed_at IS NULL
              AND  user_id     = ${input.userId}::uuid
            RETURNING user_id, id
          ),
          siblings AS (
            UPDATE password_reset_tokens
            SET    consumed_at = NOW()
            FROM   target
            WHERE  password_reset_tokens.user_id     = target.user_id
              AND  password_reset_tokens.id          != target.id
              AND  password_reset_tokens.consumed_at IS NULL
          ),
          updated AS (
            UPDATE users
            SET    password_hash = ${input.newPasswordHash}
            FROM   target
            WHERE  users.id = target.user_id
            RETURNING users.id
          )
          SELECT id FROM updated
        `),
      );
      if (result.rows.length === 0) {
        throw new Error('password_reset_token_already_consumed');
      }
    },

    async purgeExpired() {
      // Optional cron sweeper — deletes tokens whose
      // `expires_at < now() - 30 days` so the table stays
      // bounded. Mirrors `purgeExpiredOutbox` from
      // `rgpd-purge.ts` (Sprint-2 SP2.3).
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const deleted = await withConnectionRetry(() =>
        db
          .delete(passwordResetTokens)
          .where(lt(passwordResetTokens.expiresAt, cutoff))
          .returning({ id: passwordResetTokens.id }),
      );
      // `sql` import kept above so future maintenance has the
      return { deleted: deleted.length };
    },
  };
}

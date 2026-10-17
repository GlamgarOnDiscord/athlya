/**
 * `PasswordResetRepo` adapter — Sprint 7 / SP7.3 (Vague 35) — finalises
 * audit finding S2-006.
 *
 * Implements the contract exported by
 * `@athlya/auth/forgot-password.ts`:
 *
 *   - `insertToken({ userId, tokenHash, expiresAt })` — invalidate the
 *     user's active tokens and insert the new one. The plain token is
 *     NEVER seen by this adapter.
 *   - `findActiveTokenByHash(tokenHash)` — lookup with the active
 *     filter `consumed_at IS NULL AND expires_at > NOW()`.
 *   - `consumeAndResetPassword({ tokenHash, userId, newPasswordHash })`
 *     — one statement: stamp `consumed_at = NOW()` AND update the
 *     user's `password_hash`. Both writes succeed or neither does.
 *
 * RLS posture (issue #117): the flow runs pre-authentication, so there
 * are no tenant claims. Every operation goes through a SECURITY DEFINER
 * service function (migrations 0032, 0037, 0039); `athlya_app` has no
 * write privilege on `password_reset_tokens`.
 *
 * Idempotence: re-presenting the same token twice fails the second
 * time because the row's `consumed_at` is now non-null. The error
 * surfaces upstream via `findActiveTokenByHash` returning `null` on the
 * next attempt — `forgot-password.ts::confirmReset` raises
 * `token_invalid` from that null.
 *
 * Rate limit at the route layer (deferred — see SP7.4) caps the
 * insert path; this adapter does NOT enforce it.
 *
 * @see packages/db/migrations/0039_runtime_rls_gaps.sql
 * @see packages/auth/src/forgot-password.ts
 */

import { PasswordResetTokenUnavailableError } from '@athlya/auth';

import { queryRows, serviceFn, toDateOrNull, writeRows } from './service-functions.js';

import type { PasswordResetRepo } from '@athlya/auth';
import type { AthlyaDbAny } from '@athlya/db/client';

/**
 * Build the adapter. The factory is per-isolate (binds the `db` handle)
 * and stateless beyond that — no caching inside the closure.
 */
export function createDrizzlePasswordResetRepo(db: AthlyaDbAny): PasswordResetRepo {
  return {
    async insertToken(input) {
      // `auth_issue_password_reset` invalidates the user's active tokens
      // and inserts the new one in one transaction (issue #522); the
      // partial unique index `password_reset_tokens_user_active_uidx`
      // (migration 0029) backs it under concurrency. It issues nothing
      // for a deleted or unknown user. Not retried: a replay after a
      // lost commit acknowledgement would collide on `token_hash`.
      await writeRows(
        db,
        serviceFn.issuePasswordReset(input.userId, input.tokenHash, input.expiresAt),
      );
    },

    async findActiveTokenByHash(tokenHash) {
      // Active = not consumed AND not expired, filtered in SQL so a
      // clock skew in `confirmReset` can never surface a stale row.
      const rows = await queryRows<{ user_id: string; expires_at: Date | string }>(
        db,
        serviceFn.findPasswordReset(tokenHash),
      );
      const row = rows[0];
      const expiresAt = row === undefined ? null : toDateOrNull(row.expires_at);
      if (row === undefined || expiresAt === null) return null;
      return { userId: row.user_id, expiresAt };
    },

    async consumeAndResetPassword(input) {
      // `auth_consume_password_reset` (migration 0032, issue #224) runs the
      // atomic consume + sibling invalidation + password rotation of issue
      // #522 as one statement. It is a SECURITY DEFINER function because
      // the `users` UPDATE happens pre-authentication: under `athlya_app`
      // FORCE RLS a raw UPDATE would match zero rows while still consuming
      // the token. No row back = token already consumed, expired (migration
      // 0037) or not this user's. Not retried: a replay after a lost
      // commit acknowledgement would report a successful reset as consumed.
      const rows = await writeRows<{ id: string }>(
        db,
        serviceFn.consumePasswordReset(input.tokenHash, input.userId, input.newPasswordHash),
      );
      if (rows.length === 0) {
        throw new PasswordResetTokenUnavailableError();
      }
    },
  };
}

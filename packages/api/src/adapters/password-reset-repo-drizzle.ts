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
 */
export function createDrizzlePasswordResetRepo(
    db: AthlyaDbHttp,
): PasswordResetRepo {
    return {
        async insertToken(input) {
            await withConnectionRetry(() =>
                db.insert(passwordResetTokens).values({
                    userId: input.userId,
                    tokenHash: input.tokenHash,
                    expiresAt: input.expiresAt,
                }),
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
            // Atomic CTE: stamps consumed_at and updates the password in
            // one server-side statement. The `FROM consumed` join makes
            // the users UPDATE a no-op when the token UPDATE matched zero
            // rows (already consumed or wrong user). NeonHttpDatabase does
            // not support interactive transactions; a CTE is atomic on the
            // database side without needing one.
            const result = await withConnectionRetry(() =>
                db.execute<{ id: string }>(sql`
                    WITH consumed AS (
                        UPDATE password_reset_tokens
                        SET consumed_at = NOW()
                        WHERE token_hash = ${input.tokenHash}
                          AND consumed_at IS NULL
                          AND user_id = ${input.userId}::uuid
                        RETURNING id
                    )
                    UPDATE users
                    SET password_hash = ${input.newPasswordHash}
                    FROM consumed
                    WHERE users.id = ${input.userId}::uuid
                    RETURNING users.id
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

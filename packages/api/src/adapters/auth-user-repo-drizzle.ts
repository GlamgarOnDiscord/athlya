/**
 * Drizzle-backed `UserRepo` implementation for `@athlya/auth`.
 *
 * Binds the abstract repository contract declared in
 * `@athlya/auth/service` to the concrete `users` + `studios` tables
 * from `@athlya/db/schema`. Kept in `packages/api` (NOT in
 * `@athlya/db`) because it is the wiring layer that knows about both
 * the auth domain and the persistence schema — the intermediate
 * packages stay framework- and domain-agnostic.
 *
 * Design notes
 * ------------
 *  • Email normalisation (lowercase + trim) is already done by the
 *    service before calling the repo. We do NOT re-normalise here so
 *    the service remains the single source of truth for the transform.
 *  • `email_taken` is surfaced via the dedicated {@link EmailTakenError}
 *    class from `@athlya/auth` rather than a raw Postgres SQLSTATE, so
 *    the service never has to peek at driver-specific error codes.
 *  • Every transaction is opened through `db.transaction(...)`
 *    WITHOUT `withTenant` because the auth paths run either:
 *      - pre-authentication (register / login / refresh) — no claims
 *        to scope to, reads target the public-ish auth tables only.
 *      - or already authenticated via `jwtAuth` + `projectUserId`, at
 *        which point the caller (`deleteMe`) owns the tenant scoping
 *        policy through its own `withTenant` if needed.
 *    Tenant scope is enforced **at the query layer**: every read
 *    filters explicitly by `users.id` (login, findById) or
 *    `users.email` (registration uniqueness) — the email is itself
 *    globally unique by the `citext` `users_email_unique` index, so
 *    cross-tenant collision is impossible by construction. The RLS
 *    policies installed in `0001_rls.sql` + `0004_rls_hardening.sql`
 *    are the defense-in-depth backstop: even if a future query
 *    forgets a `WHERE` clause, the FORCEd RLS on `athlya_app` keeps
 *    cross-tenant rows invisible.
 *
 * @see Requirements 1.1, 1.5, 5.1.
 */

import { EmailTakenError, type UserRepo, type UserRow } from '@athlya/auth';
import { isPostgresUniqueViolation } from '@athlya/db/errors';
import { studios, users } from '@athlya/db/schema';
import { and, eq } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type { Consents } from '@athlya/shared/schemas';

/**
 * Factory — produces a `UserRepo` bound to the supplied Drizzle
 * instance. One Worker isolate holds exactly one instance; there is
 * no per-request state.
 */
export function createDrizzleUserRepo(db: AthlyaDbAny): UserRepo {
    return {
        async findUserByEmail(email) {
            const rows = await withConnectionRetry(() =>
                db
                    .select()
                    .from(users)
                    .where(eq(users.email, email))
                    .limit(1),
            );
            const row = rows[0];
            return row === undefined ? null : toUserRow(row);
        },

        async findUserById(id) {
            const rows = await withConnectionRetry(() =>
                db
                    .select()
                    .from(users)
                    .where(eq(users.id, id))
                    .limit(1),
            );
            const row = rows[0];
            return row === undefined ? null : toUserRow(row);
        },

        async findStudioBySlug(slug) {
            const rows = await withConnectionRetry(() =>
                db
                    .select({
                        id: studios.id,
                        slug: studios.slug,
                        name: studios.name,
                    })
                    .from(studios)
                    .where(eq(studios.slug, slug))
                    .limit(1),
            );
            const row = rows[0];
            return row === undefined ? null : row;
        },

        async createUser(input) {
            try {
                const [row] = await withConnectionRetry(() =>
                    db
                        .insert(users)
                        .values({
                            studioId: input.studioId,
                            email: input.email,
                            displayName: input.displayName,
                            passwordHash: input.passwordHash,
                            role: input.role,
                            consents: input.consents satisfies Consents,
                        })
                        .returning(),
                );
                if (row === undefined) {
                    throw new Error(
                        'createUser: Drizzle returned an empty result set',
                    );
                }
                return toUserRow(row);
            } catch (err) {
                // postgres-js surfaces unique-violation as SQLSTATE
                // 23505. Re-throw as the domain-level sentinel so the
                // service can map to `email_taken` without importing
                // pg codes.
                if (isPostgresUniqueViolation(err)) {
                    throw new EmailTakenError();
                }
                throw err;
            }
        },

        async softDeleteUser(id) {
            await withConnectionRetry(async () => {
                await db
                    .update(users)
                    .set({ deletedAt: new Date() })
                    .where(and(eq(users.id, id)));
            });
        },

        findOrCreateOAuthUser() {
            // OAuth sign-in is out of scope for the Niveau 2 MVP. The
            // public `/login-with-apple` and `/login-with-google`
            // routes were removed in slice B8.4 because they shipped
            // unconditional 500 stubs that expanded the public attack
            // surface for no functional gain. The `UserRepo`
            // interface still declares this method (for the
            // `loginWithApple` / `loginWithGoogle` service-layer
            // entry points covered by `@athlya/auth`'s own unit
            // tests), so we keep a defensive throw in the production
            // adapter. It can no longer be reached from the HTTP
            // surface area; landed as a dedicated slice once Apple /
            // Google developer credentials are provisioned.
            throw new Error(
                'findOrCreateOAuthUser: OAuth adapter not yet wired; use email/password register + login for now',
            );
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Map the Drizzle row shape (uses `camelCase` property names but
 * emits Postgres `snake_case` columns) to the `UserRow` contract the
 * auth service reads. The two shapes differ only in the handling of
 * `avatarUrl` and `createdAt` which the service does not consume.
 */
function toUserRow(row: typeof users.$inferSelect): UserRow {
    return {
        id: row.id,
        studioId: row.studioId,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        passwordHash: row.passwordHash,
        deletedAt: row.deletedAt,
    };
}

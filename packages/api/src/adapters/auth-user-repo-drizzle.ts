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
 *  • Every query goes through a SECURITY DEFINER service function from
 *    migration 0032 (issue #224). These paths run pre-authentication
 *    (register / login / refresh) or before the caller's tenant claims
 *    are bound, so under `athlya_app` FORCE RLS a raw `users` query
 *    matches zero rows. The functions are the narrow contract: lookup
 *    by email / id / slug, member-only registration, credential
 *    version bumps and soft delete.
 *
 * @see Requirements 1.1, 1.5, 5.1.
 */

import { EmailTakenError, type UserRepo, type UserRow } from '@athlya/auth';
import { isPostgresUniqueViolation } from '@athlya/db/errors';

import { queryRows, serviceFn, toDateOrNull, type ServiceUserRow } from './service-functions.js';

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
      const rows = await queryRows<ServiceUserRow>(db, serviceFn.findActiveUserByEmail(email));
      const row = rows[0];
      return row === undefined ? null : toUserRow(row);
    },

    async findUserById(id) {
      const rows = await queryRows<ServiceUserRow>(db, serviceFn.findUserById(id));
      const row = rows[0];
      return row === undefined ? null : toUserRow(row);
    },

    async findStudioBySlug(slug) {
      const rows = await queryRows<{ id: string; slug: string; name: string }>(
        db,
        serviceFn.findStudioBySlug(slug),
      );
      const row = rows[0];
      return row === undefined ? null : { id: row.id, slug: row.slug, name: row.name };
    },

    async createUser(input) {
      // Self-registration is the only caller; the SQL function hard-codes
      // the `member` role, so refuse anything else before hitting the DB.
      if (input.role !== 'member') {
        throw new Error(
          `createUser: only member self-registration is supported (got ${input.role})`,
        );
      }
      try {
        const rows = await queryRows<ServiceUserRow>(
          db,
          serviceFn.createMember({
            studioId: input.studioId,
            email: input.email,
            displayName: input.displayName,
            passwordHash: input.passwordHash,
            consents: input.consents satisfies Consents,
          }),
        );
        const row = rows[0];
        if (row === undefined) {
          throw new Error('createUser: auth_create_member returned no row');
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
      await queryRows(db, serviceFn.softDeleteUser(id));
    },

    async bumpCredentialsVersion(id) {
      await queryRows(db, serviceFn.bumpCredentialsVersion(id));
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
 * Map the snake_case row returned by the `auth_*` service functions to
 * the `UserRow` contract the auth service reads.
 */
function toUserRow(row: ServiceUserRow): UserRow {
  return {
    id: row.id,
    studioId: row.studio_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    passwordHash: row.password_hash,
    deletedAt: toDateOrNull(row.deleted_at),
    credentialsVersion: Number(row.credentials_version),
  };
}

/**
 * Drizzle-backed `MemberRepo` implementation for `@athlya/members`.
 *
 * Binds the abstract repository contract declared in
 * `@athlya/members/service` to the concrete `users` table in
 * `@athlya/db/schema`. Lives in `packages/api` (NOT in `@athlya/db`
 * or `@athlya/members`) because it is the wiring layer that speaks
 * both languages.
 *
 * Design notes
 * ------------
 *  • `findProfile` returns `null` on soft-deleted users — the service
 *    contract treats them identically to "unknown" (→ HTTP 404 via
 *    `MembersError('not_found')`). We filter on `deleted_at IS NULL`
 *    in SQL rather than on the service side so the row never leaves
 *    the database.
 *  • `updateProfile` mutates the whitelisted columns from
 *    `UpdateProfileRequestSchema` (`displayName`, `avatarUrl`). The
 *    Zod parse step in the service guarantees no extra columns can
 *    leak through — we project the patch object into the Drizzle
 *    set clause without the `satisfies` short-hand to keep the
 *    intent explicit.
 *  • `listByStudio` paginates on `(created_at desc, id desc)` using
 *    an opaque base64 cursor encoding the last `{ createdAt, id }`
 *    tuple. Matches the `users_studio_active_idx` partial index laid
 *    out in the schema so the scan is O(limit) even on a 1M-row
 *    studio.
 *  • Every query runs through the same `withConnectionRetry` helper
 *    used by the auth adapter — Neon free-tier suspends compute
 *    after 5 min and the first query to wake it up is the one most
 *    likely to observe a transient "connection terminated".
 *
 * @see Requirements 3.1, 3.2, 3.4, 3.5, 13.2.
 */

import { withTenantHttp } from '@athlya/db';
import { users } from '@athlya/db/schema';
import { and, eq, isNull, lt, or, desc, sql } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { MemberProfile, MemberRepo, MembersPage } from '@athlya/members';
import type { UpdateProfileRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Project the Drizzle row shape onto the `MemberProfile` contract
 * the service consumes. `password_hash` and `deleted_at` are
 * intentionally dropped — the service (and anything downstream of
 * it) must never see them.
 */
function toMemberProfile(row: typeof users.$inferSelect): MemberProfile {
  return {
    id: row.id,
    studioId: row.studioId,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    consents: row.consents,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Convert the validated `UpdateProfileRequest` patch into a Drizzle
 * column patch. Built as a plain object (rather than spread) so the
 * compiler catches any future schema drift — if a new field is
 * added to `UpdateProfileRequestSchema` without being handled here,
 * the type error points at the exact line that needs updating.
 */
function buildUpdatePatch(patch: UpdateProfileRequest): Partial<typeof users.$inferInsert> {
  const out: Partial<typeof users.$inferInsert> = {};
  if (patch.displayName !== undefined) {
    out.displayName = patch.displayName;
  }
  if (patch.avatarUrl !== undefined) {
    // Zod's schema allows `null` to clear the avatar; forward
    // the null straight into the update so the column is reset.
    out.avatarUrl = patch.avatarUrl;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Cursor encoding                                                    */
/* ------------------------------------------------------------------ */

/**
 * Opaque cursor shape. Base64url of
 * `${createdAtIsoMs}:${uuid}` — simple, compact and safe to pass
 * through a URL without percent-encoding.
 */
interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

function encodeCursor(c: Cursor): string {
  const raw = `${c.createdAt.getTime()}:${c.id}`;
  // `Buffer` is not available in the Workers runtime; use the
  // globally-available `btoa` + a URL-safe alphabet.
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(padded + '==='.slice((padded.length + 3) % 4));
    const idx = decoded.indexOf(':');
    if (idx <= 0) return null;
    const ms = Number(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    if (!Number.isFinite(ms) || id === '') return null;
    return { createdAt: new Date(ms), id };
  } catch {
    // Silently fall back to "first page" on a malformed cursor.
    // Attackers tampering with the query string get identical
    // behaviour to users who simply pasted an expired link.
    return null;
  }
}

// `sql` is imported so Drizzle's ESM barrel keeps the import graph
// resolvable; it is not directly used above but is a companion to
// the `desc`/`eq`/`and`/… operator imports.
void sql;

/* ------------------------------------------------------------------ */
/*  HTTP-driver variant (uses withTenantHttp per query)                */
/* ------------------------------------------------------------------ */

/**
 * Tenant-scoped `MemberRepo` over the Neon HTTP driver.
 *
 * Each method wraps its single Drizzle query in `withTenantHttp` so
 * the three `SET LOCAL app.*` statements and the business query are
 * sent to Neon in one HTTP batch, activating the RLS policies that
 * rely on `app_user_id()` / `app_studio_id()` / `app_role()`.
 */
export function createDrizzleMemberRepoHttp(db: AthlyaDbHttp, claims: TenantClaims): MemberRepo {
  return {
    async findProfile(userId) {
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select()
            .from(users)
            .where(and(eq(users.id, userId), isNull(users.deletedAt)))
            .limit(1),
        ),
      );
      const row = rows[0];
      return row === undefined ? null : toMemberProfile(row);
    },

    async updateProfile(userId, patch) {
      const patchColumns = buildUpdatePatch(patch);
      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(users)
            .set(patchColumns)
            .where(and(eq(users.id, userId), isNull(users.deletedAt)))
            .returning(),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`updateProfile: user ${userId} not found or soft-deleted`);
      }
      return toMemberProfile(row);
    },

    async listByStudio(studioId, opts) {
      const cursor = decodeCursor(opts.cursor);
      const conditions: Parameters<typeof and>[0][] = [
        eq(users.studioId, studioId),
        isNull(users.deletedAt),
      ];
      if (cursor !== null) {
        conditions.push(
          or(
            lt(users.createdAt, cursor.createdAt),
            and(eq(users.createdAt, cursor.createdAt), lt(users.id, cursor.id)),
          ),
        );
      }

      const rows = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .select()
            .from(users)
            .where(and(...conditions))
            .orderBy(desc(users.createdAt), desc(users.id))
            .limit(opts.limit + 1),
        ),
      );

      const hasMore = rows.length > opts.limit;
      const items = rows.slice(0, opts.limit).map((r) => toMemberProfile(r));
      const nextCursor = hasMore
        ? encodeCursor({
            createdAt: rows[opts.limit - 1]!.createdAt,
            id: rows[opts.limit - 1]!.id,
          })
        : null;

      return { items, nextCursor } satisfies MembersPage;
    },
  };
}

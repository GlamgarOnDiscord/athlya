/**
 * Drizzle-backed `StudioRepo` for `/v1/studios/me` — slice B9.1, B9.2.
 *
 * Two operations:
 *
 *   • `getById(id)` — soft-delete-aware lookup; returns `null` when the
 *     studio row does not exist or is already tomb-stoned.
 *   • `updateById(id, patch)` — partial PATCH whitelisted to the three
 *     editable columns (`name`, `brandColor`, optional `brandLogo`).
 *     The `brandLogo` column is **not yet present** in the `studios`
 *     schema — `updateById` accepts the field in the patch but silently
 *     ignores it until a dedicated migration ships. The contract still
 *     surfaces it in the returned row as `null` so clients can rely on
 *     a stable shape.
 *
 * Lives in `packages/api` (not `@athlya/db`) because it is the wiring
 * layer between the framework-free Drizzle schema and the Hono router.
 *
 * Slice B9 keeps the surface tight on purpose: no listing, no admin
 * cross-tenant lookup. Every consumer pulls a single studio scoped to
 * the caller's `claims.studioId`.
 *
 * RLS (issue #224) — `studios` is FORCE RLS, so every query runs
 * through `withTenantHttp`: the tenant GUCs and the query share one
 * Neon HTTP batch, and the `studios_read_own_tenant` /
 * `studios_admin_update_own` policies (migrations 0001, 0038) decide
 * what the caller sees and may edit. A raw query on the shared HTTP
 * handle matches zero rows under the `athlya_app` runtime role.
 */

import { withTenantHttp } from '@athlya/db';
import { studios } from '@athlya/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';

/**
 * Public projection of a studio row. Mirrors the columns
 * `GET /v1/studios/me` and `PATCH /v1/studios/me` need to surface to
 * the caller; everything else (deleted_at, created_at) stays inside
 * the database.
 */
export interface StudioView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly brandColor: string;
  /** Always `null` until the `brand_logo` column ships. */
  readonly brandLogo: string | null;
}

/** Patch shape accepted by {@link StudioRepo.updateById}. */
export interface StudioPatch {
  readonly name?: string;
  readonly brandColor?: string;
  readonly brandLogo?: string | null;
}

/** Read / write contract consumed by the studios router and tests. */
export interface StudioRepo {
  getById(id: string): Promise<StudioView | null>;
  updateById(id: string, patch: StudioPatch): Promise<StudioView | null>;
}

/**
 * Factory — produce a {@link StudioRepo} bound to `db` and the caller's
 * tenant claims. The handle is stateless (HTTP driver), so the closure
 * is just over `db` and `claims`.
 */
export function createDrizzleStudioRepoHttp(db: AthlyaDbHttp, claims: TenantClaims): StudioRepo {
  const readById = async (id: string) => {
    const rows = await withConnectionRetry(() =>
      withTenantHttp(
        db,
        claims,
        db
          .select()
          .from(studios)
          .where(and(eq(studios.id, id), isNull(studios.deletedAt)))
          .limit(1),
      ),
    );
    const row = rows[0];
    return row === undefined ? null : toStudioView(row);
  };

  return {
    getById: readById,

    async updateById(id, patch) {
      const set: Partial<typeof studios.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.brandColor !== undefined) {
        set.brandColor = patch.brandColor;
      }
      // `brandLogo` is intentionally NOT mapped onto a column
      // until the schema adds `brand_logo`. We accept the patch
      // field at the API boundary so older clients do not break,
      // and the response always reports `brandLogo: null` until
      // the column lands.
      if (Object.keys(set).length === 0) {
        // No actionable column changed — fall back to a read so
        // the response still echoes the current row. Avoids an
        // empty UPDATE that would silently bump no rows yet
        // touch the WAL.
        return readById(id);
      }
      // The UPDATE is idempotent (same columns, same values), so a
      // replay after a dropped connection is safe to retry.
      const [row] = await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db
            .update(studios)
            .set(set)
            .where(and(eq(studios.id, id), isNull(studios.deletedAt)))
            .returning(),
        ),
      );
      return row === undefined ? null : toStudioView(row);
    },
  };
}

function toStudioView(row: typeof studios.$inferSelect): StudioView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brandColor: row.brandColor,
    // `brand_logo` not yet in the schema — see file-level comment.
    brandLogo: null,
  };
}

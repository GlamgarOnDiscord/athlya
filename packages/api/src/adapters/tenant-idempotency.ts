/**
 * Idempotency store scoped to the caller's tenant claims.
 *
 * `idempotency_keys` is FORCE RLS with owner-only policies
 * (`user_id = app_user_id()`, migration 0001). Under `athlya_app` a
 * claim-less `lookup` matches nothing and a claim-less `store` is
 * refused, so replay protection silently disappears. This adapter runs
 * every statement of `@athlya/db/idempotency` through `withTenantHttp`
 * (tenant GUCs and the statement in one Neon HTTP transaction) and
 * returns the rows as an array, the shape `lookup` reads.
 */

import { withTenantHttp } from '@athlya/db/client';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { IdempotencyDb } from '@athlya/db/idempotency';
import type { SQL } from 'drizzle-orm';

export function createTenantIdempotencyDb(db: AthlyaDbHttp, claims: TenantClaims): IdempotencyDb {
  const scoped = {
    async execute(query: SQL): Promise<readonly unknown[]> {
      const result: unknown = await withTenantHttp(db, claims, db.execute(query));
      const rows: unknown = Array.isArray(result)
        ? result
        : (result as { rows?: unknown } | null)?.rows;
      return Array.isArray(rows) ? (rows as readonly unknown[]) : [];
    },
  };
  // `lookup` / `store` only call `execute(sql)` on the handle.
  return scoped as unknown as IdempotencyDb;
}

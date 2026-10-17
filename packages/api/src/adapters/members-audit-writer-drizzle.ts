/**
 * Drizzle-backed `AuditLogWriter` for `@athlya/members/consents`.
 *
 * Appends a single row to the `audit_log` table (see
 * `packages/db/src/schema/audit_log.ts`). The column set matches the
 * service-layer {@link AuditLogEntry} shape 1:1 except for the
 * server-side columns `id` (BIGSERIAL) and `createdAt` (DEFAULT
 * `now()`), which the database populates automatically.
 *
 * The `audit_log` table is append-only at the database level — a
 * trigger installed by migration `0001_rls.sql` blocks UPDATE /
 * DELETE — so this writer has no reason to expose anything beyond
 * `append`. Compliance requires every security-relevant mutation
 * (consents change, password reset, admin override, …) to land
 * exactly once in this stream (Req 22.1, 22.2).
 *
 * Error posture: the consents service catches any throw from this
 * writer and logs at `warn` level without masking the successful
 * consents update. We therefore let every driver-level failure
 * propagate unchanged.
 *
 * @see Requirements 22.1, 22.2, 22.3.
 */

import { withTenantHttp } from '@athlya/db';
import { auditLog } from '@athlya/db/schema';

import { withConnectionRetry } from './db-retry.js';

import type { AthlyaDbHttp, TenantClaims } from '@athlya/db/client';
import type { AuditLogWriter } from '@athlya/members';

/**
 * HTTP-driver variant — wraps the insert in `withTenantHttp` so RLS
 * policies on `audit_log` see the correct `app.*` session variables.
 */
export function createDrizzleAuditLogWriterHttp(
  db: AthlyaDbHttp,
  claims: TenantClaims,
): AuditLogWriter {
  return {
    async append(entry) {
      await withConnectionRetry(() =>
        withTenantHttp(
          db,
          claims,
          db.insert(auditLog).values({
            actorId: entry.actorId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId,
            metadata: entry.metadata,
          }),
        ),
      );
    },
  };
}

/**
 * Drizzle-backed {@link AuditLogStore} for the API gateway.
 *
 * Bridges `appendAudit` (packages/api/src/audit.ts) to the
 * append-only `audit_log` table. Used by admin surfaces (JWT rotate,
 * DLQ replay) and billing webhooks (issue #127).
 */

import { auditLog } from '@athlya/db/schema';

import { withConnectionRetry } from './db-retry.js';

import type { AuditEntry, AuditLogStore } from '../audit.js';
import type { AthlyaDbAny } from '@athlya/db/client';

/** Produce an {@link AuditLogStore} bound to `db` (optionally scoped to `tx`). */
export function createDrizzleAuditLogStore(db: AthlyaDbAny): AuditLogStore {
  return {
    async append(tx, entry: AuditEntry) {
      const client = (tx ?? db) as AthlyaDbAny;
      await withConnectionRetry(async () => {
        await client.insert(auditLog).values({
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          metadata: entry.metadata ?? {},
        });
      });
    },
  };
}

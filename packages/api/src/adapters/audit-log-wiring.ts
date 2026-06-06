/**
 * Audit writers for admin / billing surfaces (issue #127).
 */

import { appendAudit } from '../audit.js';
import { createDrizzleAuditLogStore } from './audit-log-store-drizzle.js';
import { getOrCreateDbHttp } from './deps-cache.js';

import type { JwtRotateAuditWriter } from '../admin/jwt-rotate-routes.js';
import type { DlqAuditWriter } from '../admin/dlq-routes.js';
import type { WebhookAuditEntry } from '@athlya/billing';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbAny } from '@athlya/db/client';

/** JWT rotate prepare → `audit_log`. */
export function createJwtRotateAuditWriter(env: AthlyaBindings): JwtRotateAuditWriter {
  const db = getOrCreateDbHttp(env.DB_URL);
  const store = createDrizzleAuditLogStore(db);
  return {
    async appendRotationPrep({ actorId, kidOld, kidNew, graceSec }) {
      await appendAudit(
        null,
        {
          actorId,
          action: 'jwt.key.rotation_prep',
          targetType: 'jwt_key',
          targetId: kidNew,
          metadata: { kidOld, kidNew, graceSec },
        },
        store,
      );
    },
  };
}

/** DLQ replay / discard → `audit_log`. */
export function createDlqAuditWriter(env: AthlyaBindings): DlqAuditWriter {
  const db = getOrCreateDbHttp(env.DB_URL);
  const store = createDrizzleAuditLogStore(db);
  return {
    async appendReplay({ actorId, entryId, messageType }) {
      await appendAudit(
        null,
        {
          actorId,
          action: 'dlq.entry.replayed',
          targetType: 'dlq_entry',
          targetId: entryId,
          metadata: { messageType: messageType ?? null },
        },
        store,
      );
    },
    async appendDiscard({ actorId, entryId }) {
      await appendAudit(
        null,
        {
          actorId,
          action: 'dlq.entry.discarded',
          targetType: 'dlq_entry',
          targetId: entryId,
          metadata: {},
        },
        store,
      );
    },
  };
}

/** Defer audit writer creation until first admin request (Worker has no env at buildApp time). */
export function lazyDlqAuditWriter(getEnv: () => AthlyaBindings): DlqAuditWriter {
  let writer: DlqAuditWriter | undefined;
  return {
    appendReplay(input) {
      writer ??= createDlqAuditWriter(getEnv());
      return writer.appendReplay(input);
    },
    appendDiscard(input) {
      writer ??= createDlqAuditWriter(getEnv());
      return writer.appendDiscard(input);
    },
  };
}

/** Defer JWT rotate audit writer until first admin request. */
export function lazyJwtRotateAuditWriter(getEnv: () => AthlyaBindings): JwtRotateAuditWriter {
  let writer: JwtRotateAuditWriter | undefined;
  return {
    appendRotationPrep(input) {
      writer ??= createJwtRotateAuditWriter(getEnv());
      return writer.appendRotationPrep(input);
    },
  };
}

/** Billing webhook audit rows (signature fail + processed). */
export function createBillingWebhookAuditAppender(db: AthlyaDbAny): {
  appendAudit: (entry: WebhookAuditEntry) => Promise<void>;
  withTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  const store = createDrizzleAuditLogStore(db);
  const txHolder: { current: unknown } = { current: null };

  return {
    appendAudit: async (entry) => {
      await appendAudit(
        txHolder.current,
        {
          actorId: entry.actorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          metadata: entry.metadata,
        },
        store,
      );
    },
    withTransaction: async (fn) =>
      db.transaction(async (tx) => {
        txHolder.current = tx;
        try {
          return await fn();
        } finally {
          txHolder.current = null;
        }
      }),
  };
}

/**
 * Admin HTTP surface for outbox observability (issue #72).
 *
 *   • `GET /admin/outbox/stats` — pending row count + oldest timestamp
 *
 * Mounted under the gateway `/admin/*` chain (`jwtAuth` +
 * `requireRole('admin')`). Per-route `enforceAdmin()` mirrors the DLQ
 * router for defence in depth.
 */

import { countPendingOutbox } from '@athlya/db/outbox';
import { Hono } from 'hono';

import { withTenantTx } from '../middleware/tenant.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../middleware/problem-details.js';

import type { AthlyaBindings, AthlyaVariables } from '../types.js';
import type { Context } from 'hono';

/** Axiom / BetterStack alert when pending stays above this for > 5 min. */
export const OUTBOX_PENDING_ALERT_THRESHOLD = 500;

/** Documented SLO: domain event → notification delivery p95. */
export const OUTBOX_EVENT_TO_NOTIFICATION_P95_MS = 120_000;

export interface OutboxAdminEnv {
  Bindings: AthlyaBindings;
  Variables: AthlyaVariables;
}

export interface OutboxStatsResponse {
  readonly pending: number;
  readonly oldestPendingOccurredAt: string | null;
  readonly alertThreshold: number;
  readonly sloEventToNotificationP95Ms: number;
  readonly backlogAlertRecommended: boolean;
}

interface AdminProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly traceId: string;
}

const ATHLYA_PROBLEM_NAMESPACE = 'https://athlya.app/problems/';
const FORBIDDEN_TYPE = `${ATHLYA_PROBLEM_NAMESPACE}forbidden`;

function buildProblem(
  status: number,
  title: string,
  code: string,
  detail: string,
  traceId: string,
  type: string,
): AdminProblemBody {
  return { type, title, status, detail, code, traceId };
}

function problemResponse(c: Context<OutboxAdminEnv>, body: AdminProblemBody): Response {
  return c.body(JSON.stringify(body), body.status as 403, {
    'content-type': PROBLEM_JSON_CONTENT_TYPE,
  });
}

function enforceAdmin(c: Context<OutboxAdminEnv>): Response | null {
  const claims = c.get('authClaims');
  if (claims === undefined || claims === null || claims.role !== 'admin') {
    return problemResponse(
      c,
      buildProblem(
        403,
        'Forbidden',
        'forbidden',
        'admin role required',
        c.get('traceId'),
        FORBIDDEN_TYPE,
      ),
    );
  }
  return null;
}

export function buildOutboxRouter(): Hono<OutboxAdminEnv> {
  const router = new Hono<OutboxAdminEnv>();

  router.get('/admin/outbox/stats', async (c) => {
    const denied = enforceAdmin(c);
    if (denied !== null) {
      return denied;
    }

    const snapshot = await withTenantTx(c, (tx) => countPendingOutbox(tx));

    const body: OutboxStatsResponse = {
      pending: snapshot.pending,
      oldestPendingOccurredAt: snapshot.oldestOccurredAt?.toISOString() ?? null,
      alertThreshold: OUTBOX_PENDING_ALERT_THRESHOLD,
      sloEventToNotificationP95Ms: OUTBOX_EVENT_TO_NOTIFICATION_P95_MS,
      backlogAlertRecommended: snapshot.pending > OUTBOX_PENDING_ALERT_THRESHOLD,
    };

    return c.json(body);
  });

  return router;
}

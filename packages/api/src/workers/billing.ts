/**
 * Billing bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/billing/* — checkout session, invoice list, Stripe webhook
 *   • /admin/*      — DLQ drain, outbox admin, JWT rotate
 *   • /v1/audit/*   — audit log read (admin only)
 *
 * A Stripe event storm that saturates CPU on the webhook handler
 * (`POST /v1/billing/webhook`) cannot block auth or reservation
 * traffic — those are served by separate Workers.
 */

import { mountAdminRouters } from '../admin-routes.js';
import { buildBaseApp, type ReadinessProbe } from '../base-app.js';
import {
  assertRequiredSecrets,
  defaultAuditDeps,
  defaultBillingDeps,
  lazyAuditDeps,
  lazyBillingDeps,
} from '../domain-deps.js';
import { installDomainScope } from '../domain-scope.js';
import { buildAuditRouter } from '../routes/audit.js';
import { buildBillingRouter } from '../routes/billing.js';

/**
 * `/health/ready` probes backed by this Worker's bindings
 * (wrangler.billing.toml): /admin/* and /v1/audit/* write and read
 * `audit_log`. No cron, Hyperdrive or R2 binding.
 */
export const READINESS: readonly ReadinessProbe[] = [
  'db',
  'redis',
  'auditLogPartitions',
  'sentryDsn',
];

const app = buildBaseApp({
  readiness: READINESS,
  // The /admin/* surface is served by this Worker only (wrangler.billing.toml).
  mountAdmin: mountAdminRouters,
  // Mounted through the base app hook so the routes sit at the same point
  // of the chain as in the monolith, behind the shared /v1/* scope (env
  // capture, BYPASSRLS guard, per-request cf).
  mountDomain: (base) => {
    const resolve = installDomainScope(base, 'billing worker', (env) => {
      assertRequiredSecrets(env);
      return { billing: defaultBillingDeps(env), audit: defaultAuditDeps(env) };
    });
    base.route('/v1/billing', buildBillingRouter(lazyBillingDeps(() => resolve().billing)));
    base.route('/v1/audit', buildAuditRouter(lazyAuditDeps(() => resolve().audit)));
  },
});

export { app };

export default {
  fetch: app.fetch.bind(app),
};

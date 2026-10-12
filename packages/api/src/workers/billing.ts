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

import { buildBaseApp } from '../base-app.js';
import { installDomainScope } from '../domain-scope.js';
import { buildAuditRouter } from '../routes/audit.js';
import { buildBillingRouter } from '../routes/billing.js';

const app = buildBaseApp({
  // Mounted through the base app hook so the routes sit at the same point
  // of the chain as in the monolith, behind the shared /v1/* scope (env
  // capture, BYPASSRLS guard, per-request cf).
  mountDomain: (base) => {
    const deps = installDomainScope(base, 'billing worker');
    base.route('/v1/billing', buildBillingRouter(deps.billing));
    base.route('/v1/audit', buildAuditRouter(deps.audit));
  },
});

export { app };

export default {
  fetch: app.fetch.bind(app),
};

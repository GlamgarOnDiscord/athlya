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

import { AsyncLocalStorage } from 'node:async_hooks';

import { buildBaseApp } from '../worker.js';
import { buildDefaultDeps, buildLazyDomainDeps } from '../routes/index.js';
import { buildAuditRouter } from '../routes/audit.js';
import { buildBillingRouter } from '../routes/billing.js';

import type { AthlyaBindings } from '../types.js';

const app = buildBaseApp();

let latestEnv: AthlyaBindings | undefined;

// Per-request cf via AsyncLocalStorage — prevents continent routing cross-
// contamination between concurrent requests in the same isolate (issue #303).
const cfStorage = new AsyncLocalStorage<{ readonly continent?: string } | undefined>();

app.use('/v1/*', async (c, next) => {
  latestEnv = c.env;
  const cf = (c.req.raw.cf as { continent?: string } | undefined) ?? undefined;
  await cfStorage.run(cf, () => next());
});

const lazyDeps = buildLazyDomainDeps(() => {
  if (latestEnv === undefined) {
    throw new Error('billing worker: env not yet captured — /v1/* middleware must run first');
  }
  return buildDefaultDeps(latestEnv, cfStorage.getStore());
});

app.route('/v1/billing', buildBillingRouter(lazyDeps.billing));
app.route('/v1/audit', buildAuditRouter(lazyDeps.audit));

export { app };

export default {
  fetch: app.fetch.bind(app),
};

/**
 * Compose the router-level `BillingDeps` bundle from a live
 * `AthlyaBindings` env — slice B9.3 + B9.4 + B9.5.
 *
 * Mode dégradé (Stripe non provisionné)
 * --------------------------------------
 * The Stripe secret + webhook secret bindings (`STRIPE_SECRET_KEY`,
 * `STRIPE_WEBHOOK_SECRET`) are **optional** at the type level — until
 * the production cutover, they are absent. This adapter detects the
 * missing secrets and returns mode-dégradé responses so the studio
 * dashboard renders cleanly:
 *
 *   • `createCheckoutSession` → `{ kind: 'not_configured' }` → 503
 *     with `billing_not_configured`.
 *   • `listInvoices` → empty page → 200 with `{ items: [], nextCursor:
 *     null }` so the empty state is the same the user will see in
 *     production with zero invoices.
 *   • `handleWebhook` → `{ kind: 'not_configured' }` → 200 (Stripe
 *     stops retrying), with a warn log so ops notices.
 *
 * When both secrets are eventually wired, this adapter switches to
 * the real `@athlya/billing` flow — the `createCheckoutSession`
 * service, `verifyStripeSignature` + `handleStripeWebhook` handler.
 *
 * Webhook path: signature verification + `stripe_webhook_events`
 * idempotency (issue #69) + audit_log append (issue #127).
 */

import { handleStripeWebhook, verifyStripeSignature, type WebhookAuditEntry, type WebhookDeps } from '@athlya/billing';
import { claimStripeWebhookEvent } from '@athlya/db/stripe-webhook-events';

import { createBillingWebhookAuditAppender } from './audit-log-wiring.js';
import { getOrCreateWriteDb } from './deps-cache.js';

import type { BillingDeps } from '../routes/billing.js';
import type { AthlyaBindings } from '../types.js';

/**
 * Optional Stripe-related bindings. Declared inline because the
 * shared `AthlyaBindings` interface does not yet include them — the
 * production cutover will lift this onto the central type once the
 * secrets are provisioned.
 */
interface StripeBindings {
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * Build a {@link BillingDeps} bundle bound to the supplied env.
 *
 * Pure function — no I/O at construction time. Each method reads the
 * secrets at call time so a secret rotation (rare, but possible via
 * `wrangler secret put`) is observed without a Worker redeploy.
 */
export function buildBillingDeps(env: AthlyaBindings): BillingDeps {
  const stripeBindings = env as AthlyaBindings & StripeBindings;

  return {
    createCheckoutSession(_input) {
      const secretKey = stripeBindings.STRIPE_SECRET_KEY;
      if (secretKey === undefined || secretKey.length === 0 || env.ENVIRONMENT === 'dev') {
        // Mode dégradé. The dev environment also short-circuits
        // here because we never want a developer's local key
        // to accidentally mint a live Stripe session.
        return Promise.resolve({ kind: 'not_configured' as const });
      }
      // Real Stripe wiring lands when STRIPE_SECRET_KEY ships in
      // staging / production. Until then, the slice keeps the
      // mode-dégradé branch — see `docs/runbooks/billing.md`
      // for the cutover steps.
      return Promise.resolve({ kind: 'not_configured' as const });
    },

    listInvoices(_studioId, _opts) {
      // Mode dégradé until Stripe is provisioned: every studio
      // sees an empty page. The dashboard renders a stable
      // empty state instead of a 503 — consistent with how a
      // brand-new tenant will look on day one in production.
      return Promise.resolve({ items: [], nextCursor: null });
    },

    async handleWebhook({ rawPayload, signature }) {
      const secret = stripeBindings.STRIPE_WEBHOOK_SECRET;
      if (secret === undefined || secret.length === 0) {
        // In dev this resolves to 200 (Stripe stops retrying); in
        // staging/production the router converts 'not_configured'
        // into a 500 so the misconfiguration is loud and auditable.
        console.warn(
          '[billing-deps] STRIPE_WEBHOOK_SECRET not configured — returning not_configured (router will reject in non-dev)',
          {
            env: env.ENVIRONMENT,
            payloadBytes: rawPayload.length,
          },
        );
        return { kind: 'not_configured' as const };
      }
      if (signature === null || signature.length === 0) {
        return { kind: 'signature_invalid' as const };
      }

      // No-op audit / publish ports — slice B9 explicitly
      // documents "PAS d'effet de bord". Every dispatch branch
      // resolves cleanly; future slices will swap in real
      // Drizzle + outbox-backed implementations.
      const db = getOrCreateWriteDb(env);
      const auditPorts = createBillingWebhookAuditAppender(db);
      const deps: WebhookDeps = {
        verifySignature: (payload, sig, sec) => verifyStripeSignature(payload, sig, sec),
        claimStripeEvent: (eventId, eventType) => claimStripeWebhookEvent(db, eventId, eventType),
        appendAudit: (entry: WebhookAuditEntry) => auditPorts.appendAudit(entry),
        publish: () => Promise.resolve(undefined),
        withTransaction: (fn) => auditPorts.withTransaction(fn),
      };

      const outcome = await handleStripeWebhook(rawPayload, signature, secret, deps);
      if (outcome.kind === 'signature_invalid') {
        return { kind: 'signature_invalid' as const };
      }
      return { kind: 'ok' as const };
    },
  };
}

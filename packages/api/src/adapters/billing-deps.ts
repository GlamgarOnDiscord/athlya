/**
 * Compose the router-level `BillingDeps` bundle — studio "pro"
 * subscription on the platform Stripe account (issue #122).
 *
 *   • `createCheckoutSession` — real Stripe Checkout (subscription mode)
 *     through the `fetch` client of `@athlya/billing`. Requires
 *     `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_PRO` and a redirect origin
 *     (`BILLING_REDIRECT_URL`, else `WEB_APP_URL`); otherwise — and
 *     always in dev — it answers `not_configured` (503).
 *   • `listInvoices` — keyset page of the studio's invoices persisted
 *     from Stripe webhooks (`billing_list_invoices`, migration 0036).
 *   • `handleWebhook` — signature verification, then ONE statement
 *     (`billing_apply_stripe_event`) claims the Stripe event, applies the
 *     subscription / invoice change, records the bus event in the outbox
 *     and appends the audit row. A failure rolls the claim back, so
 *     Stripe's retry is processed instead of discarded.
 */

import {
  createFetchStripeClient,
  createStudioCheckout,
  handleStripeWebhook,
  mapStripeEvent,
  verifyStripeSignature,
  type StripeEvent,
  type WebhookAuditEntry,
  type WebhookDeps,
} from '@athlya/billing';
import { claimStripeWebhookEvent } from '@athlya/db/stripe-webhook-events';
import { sql } from 'drizzle-orm';

import { createBillingWebhookAuditAppender } from './audit-log-wiring.js';
import { getOrCreateDbHttp, getOrCreateWriteDb } from './deps-cache.js';
import { queryRows, serviceFn, toDateOrNull, type ServiceUserRow } from './service-functions.js';

import type { AthlyaDbAny } from '@athlya/db/client';
import type { InvoicesPage } from '@athlya/shared/schemas/api';

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
  /** Stripe price id of the studio "pro" plan (`price_…`). */
  readonly STRIPE_PRICE_ID_PRO?: string;
  /** Origin of the studio app Stripe redirects back to. */
  readonly BILLING_REDIRECT_URL?: string;
}

const DEFAULT_INVOICE_PAGE = 20;

/** Opaque keyset cursor: base64url(`createdAtIso|id`). */
export function encodeInvoiceCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodeInvoiceCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const padded = cursor.replace(/-/gu, '+').replace(/_/gu, '/');
    const [createdAt, id] = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)).split('|');
    if (createdAt === undefined || id === undefined || Number.isNaN(Date.parse(createdAt))) {
      return null;
    }
    if (!/^[0-9a-f-]{36}$/u.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

interface InvoiceRow {
  readonly id: string;
  readonly stripe_invoice_id: string;
  readonly number: string | null;
  readonly status: InvoicesPage['items'][number]['status'];
  readonly amount_due: number;
  readonly currency: string;
  readonly hosted_invoice_url: string | null;
  readonly created_at: Date | string;
}

export async function listStudioInvoices(
  db: AthlyaDbAny,
  studioId: string,
  opts: { cursor?: string | undefined; limit?: number | undefined },
): Promise<InvoicesPage> {
  const limit = opts.limit ?? DEFAULT_INVOICE_PAGE;
  const after = opts.cursor === undefined ? null : decodeInvoiceCursor(opts.cursor);
  const rows = await queryRows<InvoiceRow>(
    db,
    sql`SELECT * FROM billing_list_invoices(${studioId}::uuid, ${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid, ${limit + 1})`,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const lastCreated = last === undefined ? null : toDateOrNull(last.created_at);
  return {
    items: page.map((row) => ({
      id: row.stripe_invoice_id,
      number: row.number,
      status: row.status,
      amountDue: Number(row.amount_due),
      currency: row.currency,
      createdAt: toDateOrNull(row.created_at)!.toISOString(),
      hostedInvoiceUrl: row.hosted_invoice_url,
    })),
    nextCursor:
      rows.length > limit && last !== undefined && lastCreated !== null
        ? encodeInvoiceCursor(lastCreated.toISOString(), last.id)
        : null,
  };
}

/** Claim + apply a verified Stripe event in one statement (migration 0036). */
export async function applyStripeEvent(
  db: AthlyaDbAny,
  event: StripeEvent,
  newEventId: () => string = () => crypto.randomUUID(),
): Promise<'applied' | 'duplicate' | 'ignored'> {
  const effect = mapStripeEvent(event, newEventId);
  if (effect === null) return 'ignored';
  const rows = await queryRows<{ applied: boolean }>(
    db,
    sql`SELECT billing_apply_stripe_event(${event.id}, ${event.type}, ${JSON.stringify(effect)}::jsonb) AS applied`,
  );
  return rows[0]?.applied === true ? 'applied' : 'duplicate';
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
    async createCheckoutSession(input) {
      const secretKey = stripeBindings.STRIPE_SECRET_KEY ?? '';
      const priceId = stripeBindings.STRIPE_PRICE_ID_PRO ?? '';
      const redirectBaseUrl = stripeBindings.BILLING_REDIRECT_URL ?? env.WEB_APP_URL ?? '';
      if (
        env.ENVIRONMENT === 'dev' ||
        secretKey.length === 0 ||
        priceId.length === 0 ||
        !redirectBaseUrl.startsWith('https://')
      ) {
        // Mode dégradé — dev never mints real Stripe sessions.
        return { kind: 'not_configured' as const };
      }

      const db = getOrCreateDbHttp(env.DB_URL);
      const [user] = await queryRows<ServiceUserRow>(db, serviceFn.findUserById(input.userId));
      if (user === undefined || user.deleted_at !== null || user.studio_id !== input.studioId) {
        return { kind: 'user_not_found' as const };
      }

      const session = await createStudioCheckout(
        {
          studioId: input.studioId,
          userId: input.userId,
          email: user.email,
          idempotencyKey: crypto.randomUUID(),
        },
        {
          stripe: createFetchStripeClient({ secretKey }),
          priceId,
          redirectBaseUrl,
        },
      );
      return { kind: 'ok' as const, checkoutUrl: session.url };
    },

    listInvoices(studioId, opts) {
      return listStudioInvoices(getOrCreateDbHttp(env.DB_URL), studioId, opts);
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

      // Signature failures keep the audit + transaction wrapper (issue
      // #127); verified events go through the atomic `applyEvent` path.
      const db = getOrCreateWriteDb(env);
      const auditPorts = createBillingWebhookAuditAppender(db);
      const deps: WebhookDeps = {
        verifySignature: (payload, sig, sec) => verifyStripeSignature(payload, sig, sec),
        claimStripeEvent: (eventId, eventType) => claimStripeWebhookEvent(db, eventId, eventType),
        appendAudit: (entry: WebhookAuditEntry) => auditPorts.appendAudit(entry),
        publish: () => Promise.resolve(undefined),
        withTransaction: (fn) => auditPorts.withTransaction(fn),
        applyEvent: (event) => applyStripeEvent(db, event),
      };

      const outcome = await handleStripeWebhook(rawPayload, signature, secret, deps);
      if (outcome.kind === 'signature_invalid') {
        return { kind: 'signature_invalid' as const };
      }
      return { kind: 'ok' as const };
    },
  };
}

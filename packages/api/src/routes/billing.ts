/**
 * `/v1/billing/*` domain router — slice B9.3 + B9.4 + B9.5.
 *
 * Endpoints and their middleware chains:
 *
 *   | Method | Path       | Chain                                                       |
 *   |--------|------------|-------------------------------------------------------------|
 *   | POST   | /checkout  | jwtAuth → requireRole('admin') → projectUserId → zValidator(body) → idem → handler |
 *   | GET    | /invoices  | jwtAuth → requireRole('admin') → zValidator(query) → handler |
 *   | POST   | /webhook   | (no auth) → raw-body → handler                              |
 *
 * Posture (slice B9 — Stripe not provisioned in production yet)
 * --------------------------------------------------------------
 * `@athlya/billing` is a typed port. Until a real Stripe secret is
 * wired into `wrangler.toml`, this router runs in **mode dégradé**:
 *
 *   • `POST /checkout` returns 503 with
 *     `code: 'billing_not_configured'` when STRIPE_SECRET_KEY is
 *     absent — the studio dashboard surfaces that as a "Stripe non
 *     configuré" notice instead of failing silently.
 *   • `GET /invoices` returns an empty page (`{ items: [],
 *     nextCursor: null }`) so the dashboard renders a stable empty
 *     state.
 *   • `POST /webhook` verifies the signature when
 *     STRIPE_WEBHOOK_SECRET is set. With no secret, the endpoint
 *     responds 200 immediately so Stripe stops retrying — the
 *     posture is logged at warn level for ops visibility.
 *
 * The mode dégradé is documented in `docs/runbooks/billing.md`.
 *
 * Webhook composition note
 * ------------------------
 * `POST /webhook` MUST read the raw payload via `c.req.raw.text()` —
 * the signature is computed over the exact byte sequence Stripe
 * transmitted, so any middleware that re-serialises JSON would
 * invalidate it. We also DO NOT mount the idempotency middleware on
 * this route: Stripe dedups at its end via `event.id`, and a second
 * gate would only pollute the idempotency table with non-Athlya
 * keys.
 *
 * Requirements:
 *   • 18.1 — checkout session via Stripe Connect (`createCheckoutSession`).
 *   • 18.2, 18.3 — webhook signature verification + audit row.
 *   • 18.4, 18.5 — `billing.subscription.{started,failed}` event
 *     publish.
 *   • 14.1, 14.2 — auth / validation on the admin endpoints.
 */

import { CheckoutRequestSchema, ListInvoicesQuerySchema } from '@athlya/shared/schemas/api';
import { Hono } from 'hono';

import { jwtAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/validator.js';

import {
  idempotency,
  projectUserIdFromClaims,
  readValidated,
  traceOperation,
  requireRole,
} from './helpers.js';

import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type { CheckoutRequest, InvoicesPage, ListInvoicesQuery } from '@athlya/shared/schemas/api';
import type { Context } from 'hono';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

/**
 * Discriminated outcome of {@link BillingDeps.createCheckoutSession}.
 *
 *   • `'ok'` — return 200 with `checkoutUrl`.
 *   • `'not_configured'` — Stripe secret missing / studio not
 *     onboarded; render 503 with `billing_not_configured`.
 *   • `'user_not_found'` — admin's user row vanished mid-request;
 *     render 404 (extremely rare, but surfaced clearly).
 */
export type CreateCheckoutOutcome =
  | { readonly kind: 'ok'; readonly checkoutUrl: string }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'user_not_found' };

/** Outcome of {@link BillingDeps.handleWebhook}. */
export type WebhookOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'signature_invalid' }
  | { readonly kind: 'not_configured' };

/**
 * Dependencies injected into {@link buildBillingRouter}. Loose typing
 * lets the wiring layer in `billing-deps.ts` plug in either a real
 * Stripe-backed adapter or the mode-dégradé stub used until Stripe
 * is provisioned.
 */
export interface BillingDeps {
  createCheckoutSession(input: {
    readonly userId: string;
    readonly studioId: string;
    readonly plan: 'pro';
  }): Promise<CreateCheckoutOutcome>;

  listInvoices(studioId: string, opts: ListInvoicesQuery): Promise<InvoicesPage>;

  handleWebhook(input: {
    readonly rawPayload: string;
    readonly signature: string | null;
  }): Promise<WebhookOutcome>;

  /** Dependency bundle forwarded to the idempotency middleware. */
  readonly idempotency?: IdempotencyMiddlewareDeps;
}

/* ------------------------------------------------------------------ */
/*  Problem Details helpers                                            */
/* ------------------------------------------------------------------ */

const PROBLEM_JSON = 'application/problem+json';

function problem503(c: Context<HonoEnv>, detail: string, code: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail,
      code,
      traceId: c.get('traceId'),
    }),
    503,
    { 'content-type': PROBLEM_JSON },
  );
}

function problem404(c: Context<HonoEnv>, detail: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail,
      code: 'not_found',
      traceId: c.get('traceId'),
    }),
    404,
    { 'content-type': PROBLEM_JSON },
  );
}

function problem400(c: Context<HonoEnv>, detail: string): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail,
      code: 'invalid_signature',
      traceId: c.get('traceId'),
    }),
    400,
    { 'content-type': PROBLEM_JSON },
  );
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/** Build the `/v1/billing/*` sub-router. */
export function buildBillingRouter(deps: BillingDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = deps.idempotency;

  /* ------------------------------ POST /checkout (admin) --------- */
  router.post(
    '/checkout',
    jwtAuth(),
    requireRole('admin'),
    projectUserIdFromClaims(),
    zValidator('json', CheckoutRequestSchema),
    ...(idem ? [idempotency(idem)] : []),
    async (c) => {
      traceOperation(c, 'billing.checkout');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const body = readValidated<CheckoutRequest>(c, 'json');
      const outcome = await deps.createCheckoutSession({
        userId: claims.userId,
        studioId: claims.studioId,
        plan: body.plan,
      });
      switch (outcome.kind) {
        case 'ok':
          return c.json({ checkoutUrl: outcome.checkoutUrl }, 200);
        case 'not_configured':
          return problem503(
            c,
            'Stripe billing is not configured for this environment',
            'billing_not_configured',
          );
        case 'user_not_found':
          return problem404(c, 'user not found');
      }
    },
  );

  /* ------------------------------ GET /invoices (admin) ---------- */
  router.get(
    '/invoices',
    jwtAuth(),
    requireRole('admin'),
    zValidator('query', ListInvoicesQuerySchema),
    async (c) => {
      traceOperation(c, 'billing.list-invoices');
      const claims = c.get('authClaims');
      if (claims === undefined) {
        throw new Error('authClaims unexpectedly missing after jwtAuth');
      }
      const query = readValidated<ListInvoicesQuery>(c, 'query');
      const page = await deps.listInvoices(claims.studioId, query);
      return c.json(page as unknown as Record<string, unknown>, 200);
    },
  );

  /* ------------------------------ POST /webhook (no auth) -------- */
  // Stripe webhooks: NO jwtAuth, NO idempotency, NO Zod body validator.
  // The signature header IS the authentication. The raw payload is
  // read via `c.req.raw.text()` so the byte sequence Stripe signed
  // is preserved for HMAC verification.
  router.post('/webhook', async (c) => {
    traceOperation(c, 'billing.webhook');
    const signature = c.req.header('stripe-signature') ?? null;
    const rawPayload = await c.req.raw.text();

    const outcome = await deps.handleWebhook({ rawPayload, signature });

    switch (outcome.kind) {
      case 'ok':
        return c.body(null, 200);
      case 'not_configured':
        // In dev, missing secret is acceptable — local runs rarely
        // have Stripe configured. In staging/production a missing
        // secret is a misconfiguration that must NOT silently accept
        // every unauthenticated webhook payload (issue #48).
        if (c.env.ENVIRONMENT !== 'dev') {
          const logger = c.get('logger');
          logger.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook', {
            code: 'configuration_error',
          });
          return c.body(
            JSON.stringify({
              type: 'about:blank',
              title: 'Configuration Error',
              status: 500,
              detail: 'STRIPE_WEBHOOK_SECRET is not configured',
              code: 'configuration_error',
              traceId: c.get('traceId'),
            }),
            500,
            { 'content-type': 'application/problem+json' },
          );
        }
        return c.body(null, 200);
      case 'signature_invalid':
        return problem400(c, 'invalid Stripe-Signature header');
    }
  });

  return router;
}

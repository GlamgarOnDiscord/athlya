/**
 * Billing service — task 16.1 of the Athlya implementation plan.
 *
 * Requirement 18.1 mandates: "When an authenticated member initiates
 * a subscription checkout, the Billing_Service SHALL create a Stripe
 * Checkout session scoped to the member's studio Stripe account and
 * return its URL."
 *
 * This module owns the checkout half of that contract. The matching
 * webhook handler (task 16.2) and the storage of the resulting
 * subscription row live in sibling modules.
 *
 * ### Runtime target
 *
 * The API gateway runs on Cloudflare Workers. The official `stripe`
 * npm SDK imports Node-only modules (`crypto.createHmac`,
 * `http.Agent`, etc.) at load time and is therefore not drop-in
 * compatible with the Workers runtime. Rather than pay the
 * `nodejs_compat` bundle tax on every cold start, we declare a
 * framework-free {@link StripeClient} port and inject it.
 *
 * Production (wired outside this package) implements the port with a
 * lightweight `fetch` call to Stripe's REST API, carrying the
 * `Stripe-Account` header so the session is created on behalf of the
 * studio's Connect account. This is the same pattern the Notifications
 * consumer uses for Resend and Expo.
 *
 * ### Multi-tenant scoping
 *
 * Each studio owns its own Stripe Connect account; the mapping
 * `studios.stripe_account_id` is resolved through the
 * {@link StudioBillingRepo} port. A studio that has not completed the
 * Stripe onboarding flow has `stripeAccountId === null` and the
 * service short-circuits with `{ kind: 'billing_not_configured' }` so
 * the caller can surface a 409 Problem Details response to the member
 * instead of a confusing 500.
 *
 * ### Input validation
 *
 * {@link CreateCheckoutSessionInputSchema} enforces:
 *
 *   - `userId` is a non-empty string (the API layer upstream already
 *     checked auth; we only guard against empty).
 *   - `priceId` is a non-empty string (Stripe price ids look like
 *     `price_…` but we don't lock to a prefix so test fixtures using
 *     shorter mock ids still type-check).
 *
 * `successUrl` and `cancelUrl` are NOT client-supplied: they are
 * constructed server-side from `deps.redirectBaseUrl` to prevent
 * CWE-601 open redirect (issue #241). The Stripe template variable
 * `{CHECKOUT_SESSION_ID}` is appended to the success URL so Stripe
 * substitutes the real session id on redirect.
 *
 * Invalid input throws `ZodError`. The service never swallows it —
 * the API layer translates it to RFC 7807 Problem Details.
 *
 * Related requirements: 18.1.
 */

import { z } from 'zod';

/**
 * Stripe template variable for session id substitution. Stripe
 * replaces this literal string in the `success_url` at redirect time.
 */
const STRIPE_SESSION_ID_TEMPLATE = '{CHECKOUT_SESSION_ID}';

/* ------------------------------------------------------------------ */
/*  Domain types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Billing configuration for a studio. Produced by
 * {@link StudioBillingRepo.getBilling}.
 *
 *   - `studioId`         — echoed back for audit / logging.
 *   - `stripeAccountId`  — the studio's Stripe Connect account id
 *                          (`acct_…`). `null` when the studio has
 *                          not yet onboarded through Stripe Connect;
 *                          the service refuses to create a session
 *                          in that case.
 */
export interface StudioBilling {
  readonly studioId: string;
  readonly stripeAccountId: string | null;
}

/**
 * Minimal projection of a user needed to create a checkout session.
 * Produced by {@link UserLookupRepo.getUser}.
 *
 *   - `userId`    — echoed into Checkout session metadata so the
 *                   webhook handler (task 16.2) can correlate the
 *                   `checkout.session.completed` payload back to an
 *                   Athlya user without a second lookup.
 *   - `email`     — passed to Stripe as `customer_email` so the
 *                   Checkout page is pre-filled.
 *   - `studioId`  — scopes the Stripe account lookup below.
 */
export interface UserBillingContext {
  readonly userId: string;
  readonly email: string;
  readonly studioId: string;
}

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Studio billing configuration lookup.
 *
 * Production implementation: Drizzle query against `studios` filtered
 * by `id = $1`, selecting `stripe_account_id`. The query runs under
 * the system role (the API layer has already authorised the caller)
 * so RLS does not block the lookup.
 *
 * Returns `null` when the studio does not exist. `stripeAccountId`
 * is nullable at the domain layer to encode "studio exists but has
 * not completed Stripe onboarding".
 */
export interface StudioBillingRepo {
  getBilling(studioId: string): Promise<StudioBilling | null>;
}

/**
 * User lookup contract. Returns the fields the service needs to
 * create a Checkout session — it is deliberately narrower than the
 * full `users` projection to keep the port cheap to stub in tests.
 *
 * Returns `null` when the user no longer exists (RGPD cascade or
 * never existed). The service surfaces this as
 * `{ kind: 'user_not_found' }` without calling Stripe.
 */
export interface UserLookupRepo {
  getUser(userId: string): Promise<UserBillingContext | null>;
}

/**
 * Parameters accepted by {@link StripeClient.createCheckoutSession}.
 *
 * Mirrors the subset of Stripe's `POST /v1/checkout/sessions` payload
 * that the Billing service actually uses. The adapter is free to
 * translate `stripeAccount` into the `Stripe-Account` request header
 * (Connect accounts) or into any other transport detail — this port
 * keeps the business intent separate from the wire format.
 */
export interface CheckoutSessionParams {
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly customerEmail?: string;
  readonly metadata?: Record<string, string>;
  /**
   * Stripe Connect account id (`acct_…`) the session is created
   * on behalf of. The adapter forwards it as the `Stripe-Account`
   * header.
   */
  readonly stripeAccount?: string;
}

/**
 * Result returned by {@link StripeClient.createCheckoutSession}.
 *
 *   - `id`  — the Stripe Checkout Session id (`cs_…`).
 *   - `url` — the hosted redirect URL the member should be sent to.
 */
export interface CheckoutSession {
  readonly id: string;
  readonly url: string;
}

/**
 * Stripe API port. The production adapter makes a `fetch` call to
 * `https://api.stripe.com/v1/checkout/sessions` carrying
 * `Authorization: Bearer {secret_key}` and the `Stripe-Account`
 * header derived from `params.stripeAccount`.
 *
 * Implementations MUST throw on any non-2xx Stripe response; the
 * service propagates the thrown error so the API layer can retry /
 * surface it as a 502 Problem Details. Callers MUST NOT swallow
 * errors — dropping a Stripe failure silently would hide billing
 * outages from the member.
 */
export interface StripeClient {
  createCheckoutSession(params: CheckoutSessionParams): Promise<CheckoutSession>;
}

/* ------------------------------------------------------------------ */
/*  Input schema                                                       */
/* ------------------------------------------------------------------ */

/**
 * Public input contract for {@link createCheckoutSession}. Zod-parsed
 * up front so malformed data throws a typed `ZodError` the API layer
 * can translate into RFC 7807 Problem Details.
 *
 * `successUrl` and `cancelUrl` are intentionally absent — they are
 * constructed server-side from `CreateCheckoutSessionDeps.redirectBaseUrl`
 * to prevent CWE-601 open redirect (issue #241).
 */
export const CreateCheckoutSessionInputSchema = z.object({
  userId: z.string().min(1),
  priceId: z.string().min(1),
});

/** Inferred input type — callers use this, the schema is internal. */
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionInputSchema>;

/* ------------------------------------------------------------------ */
/*  Dependency bag                                                     */
/* ------------------------------------------------------------------ */

/** Dependency bag accepted by {@link createCheckoutSession}. */
export interface CreateCheckoutSessionDeps {
  readonly users: UserLookupRepo;
  readonly billing: StudioBillingRepo;
  readonly stripe: StripeClient;
  /**
   * Base URL for server-side redirect construction (CWE-601 fix, issue #241).
   * Must be an absolute `https://` origin, e.g. `https://app.athlya.app`.
   * `successUrl` becomes `${redirectBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`
   * and `cancelUrl` becomes `${redirectBaseUrl}/billing/cancel`.
   */
  readonly redirectBaseUrl: string;
}

/* ------------------------------------------------------------------ */
/*  Result                                                             */
/* ------------------------------------------------------------------ */

/**
 * Discriminated result of {@link createCheckoutSession}.
 *
 *   - `'ok'`                     — Stripe returned a session; the
 *                                  caller forwards `url` to the
 *                                  member.
 *   - `'user_not_found'`         — the user id does not resolve; the
 *                                  API layer returns 404.
 *   - `'billing_not_configured'` — the studio exists but has not
 *                                  onboarded through Stripe Connect,
 *                                  or the studio row itself is
 *                                  missing; the API layer returns
 *                                  409.
 *
 * Transport / Stripe errors are NOT encoded here — they propagate as
 * thrown exceptions so the caller can log, retry or fail the
 * request. Swallowing them as a `kind` would hide real billing
 * outages from the member.
 */
export type CreateCheckoutSessionResult =
  | {
      readonly kind: 'ok';
      readonly sessionId: string;
      readonly url: string;
    }
  | { readonly kind: 'user_not_found' }
  | { readonly kind: 'billing_not_configured' };

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create a Stripe Checkout session for a member on behalf of their
 * studio's Connect account.
 *
 * Flow:
 *
 *   1. **Validate input.** Zod rejects empty ids with a `ZodError`.
 *   2. **Look up the user.** Missing → `'user_not_found'`. No Stripe
 *      call is made.
 *   3. **Look up the studio's billing.** Missing studio row or
 *      `stripeAccountId === null` → `'billing_not_configured'`.
 *      The Stripe call is skipped because the session would fail
 *      Stripe's own validation with a less-helpful error.
 *   4. **Build redirect URLs server-side.** `successUrl` and `cancelUrl`
 *      are derived from `deps.redirectBaseUrl` — never from client input
 *      — to prevent CWE-601 open redirect (issue #241).
 *   5. **Call Stripe.** Forward the constructed URLs, the resolved
 *      Connect account id and per-member metadata (`userId`, `studioId`)
 *      so the webhook handler (task 16.2) can correlate later.
 *   6. **Return** the `sessionId` + hosted `url`.
 *
 * Any thrown error from the Stripe client propagates unchanged.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  deps: CreateCheckoutSessionDeps,
): Promise<CreateCheckoutSessionResult> {
  // Step 1 — validate. Throws ZodError on malformed input.
  const parsed = CreateCheckoutSessionInputSchema.parse(input);

  const { users, billing, stripe, redirectBaseUrl } = deps;

  // Step 2 — user lookup.
  const user = await users.getUser(parsed.userId);
  if (user === null) {
    return { kind: 'user_not_found' };
  }

  // Step 3 — studio billing lookup.
  const studioBilling = await billing.getBilling(user.studioId);
  if (studioBilling === null || studioBilling.stripeAccountId === null) {
    return { kind: 'billing_not_configured' };
  }

  // Step 4 — build redirect URLs server-side (CWE-601, issue #241).
  // Stripe replaces {CHECKOUT_SESSION_ID} with the real session id.
  const successUrl = `${redirectBaseUrl}/billing/success?session_id=${STRIPE_SESSION_ID_TEMPLATE}`;
  const cancelUrl = `${redirectBaseUrl}/billing/cancel`;

  // Step 5 — Stripe call. Metadata carries the correlation keys the
  // webhook handler needs; `customerEmail` pre-fills the Stripe
  // Checkout page; `stripeAccount` pins the session to the studio's
  // Connect account.
  const session = await stripe.createCheckoutSession({
    priceId: parsed.priceId,
    successUrl,
    cancelUrl,
    customerEmail: user.email,
    metadata: {
      userId: user.userId,
      studioId: user.studioId,
    },
    stripeAccount: studioBilling.stripeAccountId,
  });

  // Step 6 — ok.
  return {
    kind: 'ok',
    sessionId: session.id,
    url: session.url,
  };
}

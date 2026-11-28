# Member payments: architecture decision

**Status:** proposed, awaiting approval (billing scope: Tom or Pierre must approve before merge).
**Issue:** #715. **Scope:** design only. No code, no migration, no secret ships with this document.

This document decides how a member pays their studio for a drop-in class, a class pack or a
membership, and how Athlya stays out of the flow of funds.

## 1. Context

What exists today (verified on `master`):

| Piece                                          | State                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Studio "pro" plan                              | Live code. Checkout in `subscription` mode on the **platform** account (`packages/billing/src/studio-checkout.ts`, `stripe-client.ts`), state in `studio_subscriptions` / `studio_invoices` (migration `0036`).                                                                                                                            |
| Webhook `POST /v1/billing/webhook`             | Platform-scope endpoint. Raw-body HMAC check (`webhook.ts`), then one SQL call `billing_apply_stripe_event` claims `stripe_webhook_events` (migration `0010`), applies the change, writes the outbox and the audit row, all or nothing, under the dedicated role `athlya_billing`. Served by the billing Worker (`wrangler.billing.toml`). |
| Member checkout port (`service.ts`, req. 18.1) | Not wired. It assumes a `studios.stripe_account_id` column that does not exist and forwards a `Stripe-Account` header. It is the seed of this design, not something running.                                                                                                                                                               |
| Member invoices                                | None. `docs/runbooks/rgpd-export.md` ships an empty `invoices.json` and says when member billing ships, the export must list them.                                                                                                                                                                                                         |

## 2. Decisions

Decided by the owner, not open for this review:

1. **Open platform, no commission.** Members pay their studio directly. Athlya takes no
   application fee today: no `application_fee_amount`, no `application_fee_percent`.
2. **The studio pays the processor fees.** Charges are **direct charges** on the studio's
   connected account, so the processor bills its fees to the studio, not to Athlya.
3. **Separate from Athlya's own revenue.** A future paid Athlya plan for studios keeps running
   on the platform account (today's `studio_subscriptions`) and never mixes with member money.
4. **Stripe Connect first**, other providers later behind one abstraction (section 8).

Consequences this document derives from them:

- The studio is the **merchant of record**: its name on the card statement, its refund and
  dispute liability, its VAT. Athlya intends to act as software, not as a payment facilitator.
  Direct charges support that position but do not settle Athlya's regulatory status in every
  country: it is an assumption that counsel must confirm before Phase 5 (live mode).
- With Stripe pricing the connected accounts directly, Stripe states "No fees for your platform"
  ([Connect pricing](https://stripe.com/connect/pricing)). Processor fees for the studio are on
  [stripe.com/pricing](https://stripe.com/pricing). Both pages may change; this document quotes
  no figure.

## 3. Stripe connected account (studio side)

Created with the **Accounts v2 API** (`POST /v2/core/accounts`), never with the legacy
`type: standard|express|custom`. The SaaS configuration from
[Create a connected account](https://docs.stripe.com/connect/saas/tasks/create):

| Property                                     | Value                                                                                                   | Why                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `dashboard`                                  | `full`                                                                                                  | The studio runs its own business, refunds and answers disputes in its Stripe Dashboard. |
| `defaults.responsibilities.fees_collector`   | `stripe`                                                                                                | Decision 2: Stripe bills its fees to the studio.                                        |
| `defaults.responsibilities.losses_collector` | `stripe`                                                                                                | Stripe, not Athlya, carries an unrecoverable negative balance.                          |
| `configuration.merchant.capabilities`        | `card_payments` requested (minimum); `sepa_debit_payments` and local methods as the studio enables them | Required to accept direct charges.                                                      |
| `configuration.customer`                     | not set                                                                                                 | Only needed if the Athlya plan ever bills the studio through the same Account (Q6).     |

A studio that already has a Stripe account links it during onboarding (Stripe "networked
onboarding"); Athlya never asks for an API key from the studio.

### Onboarding flow

1. Studio admin clicks **Accept payments** in the studio app. API (`POST /v1/billing/connect/account`,
   admin only, `Idempotency-Key`) first inserts the `studio_payment_accounts` row (unique
   `studio_id`, state `creating`, no `acct_...` yet), then creates the v2 Account with an
   idempotency key derived from the studio id and `metadata.studioId`, and writes `acct_...` back.
   The local row is the duplicate guard, not the Stripe key: Stripe may prune a key after 24 hours
   and treat its reuse as a new request. A retry that finds a row still `creating` first looks for
   an existing Account carrying that `metadata.studioId` and adopts it before creating one.
2. API creates an Account Link (`POST /v2/core/account_links`, `use_case.type =
account_onboarding`, `collection_options.fields = eventually_due` for up-front collection) and
   returns its single-use URL. Embedded onboarding (`account_onboarding` component via an Account
   Session) is the alternative when the studio app wants to keep the admin in place; Stripe-hosted
   links do not work inside mobile web views
   ([Onboard your connected account](https://docs.stripe.com/connect/saas/tasks/onboard)).
3. `refresh_url` mints a new link; `return_url` carries no state, so the API re-reads the Account
   and never trusts the redirect as "done".
4. Readiness comes only from Stripe: `configuration.merchant.capabilities.card_payments.status ===
'active'` and no requirement whose `minimum_deadline.status` is `past_due`. Never the v1
   `charges_enabled`. Kept fresh by `v2.core.account[requirements].updated` and
   `v2.core.account[configuration.merchant].capability_status_updated` (section 6).

### KYC states and the studio dashboard

| Athlya state      | Derived from                                                           | Studio dashboard shows                                            | Member checkout |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------- |
| `not_started`     | no row                                                                 | "Accept payments" call to action                                  | hidden          |
| `onboarding`      | Account exists, `currently_due` requirements, capability not active    | "Finish setup" (new Account Link)                                 | hidden          |
| `pending_review`  | nothing due, capability `pending`                                      | "Stripe is verifying your details"                                | hidden          |
| `active`          | `card_payments` active, nothing `currently_due` and nothing `past_due` | Live badge, link to the Stripe Dashboard, payouts summary         | shown           |
| `action_required` | active, but a requirement `currently_due` with a deadline              | Banner with the deadline (Stripe `notification_banner` component) | shown           |
| `restricted`      | a requirement `past_due` or capability `restricted`/`inactive`         | Blocking banner, "Update details"                                 | hidden          |
| `disconnected`    | Account closed or platform access removed                              | "Payments disconnected", reconnect option                         | hidden          |

When several rows match, the first of `disconnected`, `restricted`, `action_required`, `active`
wins, so a deadline-bearing requirement always shows its banner instead of the Live badge. The
internal `creating` state (step 1 of the onboarding flow) displays as `not_started`.

The `notification_banner` embedded component is mandatory once a studio is active: it surfaces
new requirements before they disable payments. Payouts, balances and disputes stay in the Stripe
Dashboard (full access); embedded `payments` / `payouts` components are a later nice-to-have.

## 4. Charge model

- **Direct charges only.** Every Stripe call that creates a member object (Checkout Session,
  Customer, Subscription, Refund, Billing Portal session) carries `Stripe-Account: acct_...`
  ([Direct charges](https://docs.stripe.com/connect/direct-charges)). The PaymentIntent, Charge
  and balance transaction live on the studio account; Athlya's balance never moves.
- **No `application_fee_amount` / `application_fee_percent`** anywhere. A contract test on the
  form encoder will assert it (same pattern as `encodeCheckoutForm`).
- **Checkout Sessions, not raw PaymentIntents**, for every on-session purchase: Stripe hosts the
  card form, 3DS and wallets. No `payment_method_types`: dynamic payment methods, configured by the
  studio in its Dashboard.
- **Refunds:** issued by the studio, either in its Stripe Dashboard or from an Athlya admin action
  (`POST /v1/refunds` with `Stripe-Account`). Either way Athlya learns of it from the webhook
  (`charge.refunded`, `refund.updated`) and adjusts entitlements; the money comes from the studio
  balance.
- **Disputes:** debited from the studio balance; the studio answers in its Stripe Dashboard.
  Athlya records `charge.dispute.*` to show status and to freeze unused pack credits (Q3).
- **Negative balance:** Stripe's risk (`losses_collector = stripe`), then the studio's. Never Athlya.

## 5. Products

Each studio owns its catalog **on its connected account** (Products and Prices created with
`Stripe-Account`). One Product per offer, several Prices only for variants of the same offer.

| Offer               | Stripe mode                                                  | Athlya entitlement                                                      | Granted on                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop-in (one class) | Checkout `mode=payment`, linked to one class                 | One credit reserved for that class, booking confirmed                   | `checkout.session.completed` with `payment_status=paid`, or `async_payment_succeeded`                                                                                |
| Class pack (N)      | Checkout `mode=payment`                                      | N credits in a ledger, optional expiry                                  | same                                                                                                                                                                 |
| Membership          | Checkout `mode=subscription` (Billing on the studio account) | Unlimited or N per period while the subscription is `active`/`trialing` | `customer.subscription.created/updated` with status `active` or `trialing`; revoked on `unpaid`, `canceled`, `incomplete_expired` or `customer.subscription.deleted` |

- Member self-service (card update, cancel) uses the Stripe **Customer Portal** opened with
  `Stripe-Account`, configured per studio.
- A member is a Customer **on the studio account**, one per (studio, member). The same person in
  two studios is two Customers on two accounts; nothing is shared across studios.
- Membership access follows the subscription status, so a trial is provisioned before any
  payment. `invoice.paid`, `invoice.payment_failed` and `invoice.payment_action_required` record
  the payment outcome and drive the member notices, not the entitlement itself.
- Fulfilment is driven by the webhook, never by the success page. A booking that waits for
  payment holds its seat for the Checkout Session lifetime only (`expires_at`), then releases it
  on `checkout.session.expired`.

## 6. Webhooks

Stripe sends events to two scopes ([Connect webhooks](https://docs.stripe.com/connect/webhooks)),
and v2 Account events are thin events, so the design adds two endpoints next to the existing one:

| Endpoint (billing Worker)                       | Stripe scope                        | Payload                            | Secret                          | Events                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/billing/webhook` (exists)             | Your account                        | snapshot (v1)                      | `STRIPE_WEBHOOK_SECRET`         | unchanged: Athlya plan only                                                                                                                                                                                                                                                                                                                   |
| `POST /v1/billing/connect/webhook` (new)        | Connected accounts (`connect=true`) | snapshot (v1), top-level `account` | `STRIPE_CONNECT_WEBHOOK_SECRET` | `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed`, `.expired`; `customer.subscription.created/updated/deleted`; `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`; `charge.refunded`, `refund.updated`; `charge.dispute.created/updated/closed`; `account.application.deauthorized` |
| `POST /v1/billing/connect/account-events` (new) | Your account, event destination     | thin (v2)                          | `STRIPE_ACCOUNT_EVENTS_SECRET`  | `v2.core.account[requirements].updated`, `v2.core.account[configuration.merchant].capability_status_updated`, `v2.core.account.closed`                                                                                                                                                                                                        |

Rules, each one reusing what `webhook.ts` and migration `0036` already enforce:

1. **Raw body, signature first**, same `verifyStripeSignature` with the endpoint's own secret;
   failure is a 400 plus an audit row, atomically (req. 18.3).
2. **One claim per event:** the new apply function inserts into the existing
   `stripe_webhook_events` (`event_id` PK) in the **same statement** that applies the change,
   writes the outbox and the audit row. A failure rolls the claim back so Stripe's retry is
   processed, a replay is a no-op. The three endpoints share the table; a nullable `account_id`
   column (section 9) records which connected account an event came from.
3. **Tenant from the account, never from metadata:** the event's top-level `account` (or the thin
   event's `related_object.id`) must map to exactly one studio in `studio_payment_accounts`, or
   the event is acknowledged and audited, never applied. `metadata.studioId` is only a cross-check,
   applied when the event object carries it (objects Athlya created: Checkout Sessions,
   Subscriptions); objects without it (`account.application.deauthorized` carries an
   `application`, a refund made in the studio Dashboard has no Athlya metadata) are resolved from
   the account alone. A mismatch is acknowledged and audited, never applied.
4. **`livemode` must match the environment.** A production Connect endpoint also receives test
   events; a mismatch is acknowledged and dropped.
5. **Thin events are fetched, not trusted:** the handler retrieves the current Account
   (`GET /v2/core/accounts/{id}` with `include` for requirements and merchant configuration)
   and stores the derived state with the event `created` as `source_event_at`, so a late event
   never rolls the state back (same guard as `studio_subscriptions`).
6. **Unknown event types** are acknowledged (200) and audited, as today.

## 7. Security

- **Secrets per environment**, set on the billing Worker only (`wrangler.billing.toml`, checked by
  `scripts/verify-secrets.mjs`): the two new webhook secrets, plus a **restricted key** (`rk_...`)
  for Connect calls instead of reusing `STRIPE_SECRET_KEY`, with only Accounts, Account Links,
  Products, Prices, Checkout, Customers, Subscriptions, Refunds and Billing Portal write
  permissions. The exact permission names, and restricted-key support for the v2 Accounts
  endpoints, are to confirm in the Stripe Dashboard at Phase 1; if v2 needs the secret key, only
  account creation uses it. Separate Stripe sandboxes for dev, CI and staging; live keys only in
  production, from the ops vault.
- **No per-studio secret with Stripe:** the platform key plus `Stripe-Account` is enough. Providers
  that need per-merchant OAuth tokens (Mollie, GoCardless, PayPal) require envelope-encrypted token
  storage, which is one reason they come later (section 8).
- **No card data** ever reaches Athlya: Stripe-hosted Checkout and Portal keep the PCI scope minimal
  (to confirm with Stripe's PCI guidance for the final integration). Athlya stores
  Stripe ids, amounts, currencies and statuses only.
- **SCA / 3DS** is handled by Checkout on-session; renewals that need authentication arrive as
  `invoice.payment_action_required` and the member is sent the hosted invoice link.
- **RLS per studio:** every new table carries `studio_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`;
  admins read their studio, a member reads only their own rows. Writes go through `SECURITY
DEFINER` functions owned by `athlya_owner`, `SET search_path = public, pg_temp`, executable by
  `athlya_billing` only (webhooks) or `athlya_app` only (checkout intent), never both.
- **Server-side redirects only** (CWE-601, issue #241) and the `checkout.stripe.com` URL check
  stay; onboarding link URLs get the same host allowlist check before they reach the browser.
- **Pin `Stripe-Version`** on every call. The current fetch client sends none; v2 endpoints need it.
- **CSP:** the studio app adds `https://*.stripe.com` to `script-src`, `frame-src`, `connect-src`
  only if embedded components ship.

## 8. Provider abstraction

One port in `@athlya/billing`, one adapter per provider, all Workers-friendly `fetch` clients like
`stripe-client.ts`. Sketch only, not code to merge:

```ts
type ProviderId = 'stripe' | 'mollie' | 'gocardless' | 'paypal';
type Money = { readonly amountMinor: number; readonly currency: string };
type AccountState =
  'onboarding' | 'pending_review' | 'active' | 'action_required' | 'restricted' | 'disconnected';

interface MemberPaymentProvider {
  readonly id: ProviderId;
  readonly supports: {
    readonly oneOff: boolean;
    readonly recurring: boolean;
    readonly cards: boolean;
  };
  createAccount(input: {
    studioId: string;
    country: string;
    email: string;
    idempotencyKey: string;
  }): Promise<{ providerAccountId: string }>;
  createOnboardingLink(input: {
    providerAccountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<{ url: string }>;
  getAccountState(providerAccountId: string): Promise<{ state: AccountState; dueBy: Date | null }>;
  createCheckout(input: {
    providerAccountId: string;
    mode: 'one_off' | 'recurring';
    priceRef: string;
    customerRef: string | null;
    metadata: Readonly<Record<string, string>>;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<{ checkoutId: string; url: string; expiresAt: Date }>;
  refund(input: {
    providerAccountId: string;
    paymentRef: string;
    amount?: Money;
    idempotencyKey: string;
  }): Promise<{ refundRef: string }>;
  cancelRecurring(input: {
    providerAccountId: string;
    recurringRef: string;
    atPeriodEnd: boolean;
  }): Promise<void>;
  /** Verify (or fetch back), then normalise. Never trusts an unverified payload. */
  parseWebhook(req: { rawBody: string; headers: Headers }): Promise<NormalisedPaymentEvent | null>;
}

type NormalisedPaymentEvent = {
  readonly eventId: string;
  readonly providerAccountId: string;
  readonly occurredAt: Date;
  readonly livemode: boolean;
} & (
  | { kind: 'account.updated' }
  | { kind: 'account.disconnected' }
  | { kind: 'checkout.paid' | 'checkout.failed' | 'checkout.expired'; checkoutId: string }
  | { kind: 'recurring.updated'; recurringRef: string; status: string; periodEnd: Date | null }
  | {
      kind:
        'recurring.payment_succeeded' | 'recurring.payment_failed' | 'recurring.action_required';
      recurringRef: string;
      invoiceRef: string;
      amount: Money;
      hostedInvoiceUrl: string | null;
    }
  | { kind: 'payment.refunded'; paymentRef: string; refunded: Money }
  | { kind: 'dispute.updated'; paymentRef: string; status: 'open' | 'won' | 'lost' }
);
```

| Concern          | Stripe Connect                             | Mollie Connect                                                                                                                           | GoCardless (partner)                                                    | PayPal (multiparty)                                                |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Link a studio    | v2 Account + Account Link                  | OAuth or Client Links API                                                                                                                | OAuth                                                                   | Partner Referrals API (limited release, partner approval)          |
| Act for a studio | platform key + `Stripe-Account`            | per-merchant OAuth token + `profileId`                                                                                                   | per-merchant OAuth token                                                | `PayPal-Auth-Assertion` + `PayPal-Partner-Attribution-Id`          |
| Readiness        | merchant capability status, requirements   | Capabilities API / onboarding status                                                                                                     | merchant verification status                                            | seller status from partner API                                     |
| One-off          | Checkout `mode=payment`                    | Payments API (hosted checkout)                                                                                                           | no (direct debit only, Instant Bank Pay aside)                          | Orders v2                                                          |
| Recurring        | Billing subscriptions on the account       | Customers + Mandates + Subscriptions APIs                                                                                                | Mandates + Subscriptions (SEPA)                                         | Subscriptions API (to verify for multiparty)                       |
| Fees land on     | studio (`fees_collector = stripe`)         | studio account (to confirm in the contract)                                                                                              | studio account (to confirm)                                             | seller (to confirm)                                                |
| Webhook trust    | HMAC `Stripe-Signature`, snapshot or thin  | unsigned POST of an id, **must fetch the resource**                                                                                      | signed `Webhook-Signature` header                                       | verify via the notifications verify API                            |
| Docs             | [Connect](https://docs.stripe.com/connect) | [Mollie Connect](https://docs.mollie.com/docs/connect-platforms-getting-started), [webhooks](https://docs.mollie.com/reference/webhooks) | [OAuth](https://docs.gocardless.com/docs/api-reference/oauth-reference) | [API requests](https://developer.paypal.com/api/make-api-requests) |

**Recommended order:** Stripe, then **Mollie** (full coverage of one-off and recurring with cards,
SEPA and Benelux methods, EU company, closest shape to Stripe), then **GoCardless** (memberships
by SEPA mandate only, worth it when a studio wants direct debit outside Stripe), then **PayPal**
last (limited-release partner programme, approval gate, heaviest headers). Stripe itself already
offers SEPA Direct Debit on the connected account, so provider 2 is driven by studio demand, not
by a feature gap. Cells marked "to confirm" or "to verify" were not confirmed in the providers'
public docs while writing this and must be before that phase starts.

## 9. Data model sketch

**Future expand-only migration, not part of this PR, requires Tom or Pierre's approval.** Every
column nullable or defaulted, no change to existing tables except one nullable column, RLS on all.

| Table                           | Key columns                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio_payment_accounts`       | `studio_id` (unique, FK), `provider`, `provider_account_id` (unique, null while `creating`), `state`, `due_by`, `livemode`, `source_event_at`, `disconnected_at`                            |
| `studio_offers`                 | `id`, `studio_id`, `kind` (`drop_in`, `class_pack`, `membership`), `provider_product_id`, `provider_price_id`, `credits`, `validity_days`, `interval`, `amount_minor`, `currency`, `active` |
| `member_payment_customers`      | `studio_id`, `user_id`, `provider`, `provider_customer_id`; unique (`studio_id`, `user_id`, `provider`)                                                                                     |
| `member_orders`                 | `id`, `studio_id`, `user_id`, `offer_id`, `class_id` (drop-in), `checkout_id` (unique), `payment_ref`, `amount_minor`, `currency`, `status`, `refunded_minor`, `source_event_at`            |
| `member_subscriptions`          | `studio_id`, `user_id`, `offer_id`, `provider_subscription_id` (unique), `status`, `current_period_end`, `cancel_at_period_end`, `source_event_at`                                          |
| `member_credit_ledger`          | `id`, `studio_id`, `user_id`, `delta`, `reason` (`purchase`, `booking`, `cancel`, `refund`, `expiry`, `admin`), `order_id`, `reservation_id`, `expires_at`; balance = sum                   |
| `member_payment_disputes`       | `studio_id`, `order_id`, `provider_dispute_id` (unique), `status`, `amount_minor`, `evidence_due_by`                                                                                        |
| `stripe_webhook_events` (alter) | add nullable `account_id text` for audit; PK unchanged                                                                                                                                      |

Functions: one `billing_apply_member_event(event_id, event_type, effect jsonb)` mirroring
`billing_apply_stripe_event`, granted to `athlya_billing` only, and a `SECURITY INVOKER` listing
per table for the studio and member UIs. pgTAP covers cross-studio isolation and replay. The RGPD
export then fills `invoices.json` from `member_orders` and `member_subscriptions`.

## 10. Rollout

| Phase | Content                                                                                                                      | Needs Tom or Pierre                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0     | This ADR                                                                                                                     | approval to merge (billing)                                                |
| 1     | Studio onboarding: `studio_payment_accounts`, account and link routes, thin-event endpoint, dashboard states. Test mode only | migration, billing merge, Connect platform profile in the Stripe Dashboard |
| 2     | Drop-in and class packs: offers, Checkout, Connect endpoint, credit ledger, booking hook                                     | migration, billing merge, new secrets                                      |
| 3     | Memberships: subscriptions, Customer Portal, entitlement checks in booking                                                   | migration, billing merge                                                   |
| 4     | Refunds and disputes in the studio app, RGPD export of member invoices                                                       | billing merge                                                              |
| 5     | Pilot studio in **live** mode                                                                                                | live keys, terms of service update, production deploy                      |
| 6     | Provider 2 behind the port                                                                                                   | provider contract, migration, billing merge                                |

Each phase is one issue and one PR at most, migrations merged one at a time, every new table
expand-only (`docs/runbooks/expand-contract-migrations.md`).

## 11. Open questions for Tom

1. **Booking without payment:** may a studio keep "book now, pay at the desk"? If yes, payment is
   an option per class, not a gate.
2. **Pack credit rules:** expiry default, transferable or not, refund of unused credits.
3. **Disputes:** freeze the member's remaining credits while a dispute is open, or only show it?
4. **Studio leaves Athlya:** subscriptions keep running on its Stripe account after disconnect
   (Stripe behaviour). Do we cancel them, or hand them over untouched?
5. **VAT and invoices:** the studio is merchant of record. Do we enable Stripe Tax on connected
   accounts (only with an active registration), or leave invoicing to the studio?
6. **Athlya plan on the same Account:** keep the pro plan on a platform Customer as today, or bill
   it through the v2 Account `customer` configuration once studios are connected?
7. **Hosted vs embedded onboarding** for the first release (hosted is less work; embedded is
   required inside the mobile app).
8. **Data retention:** member orders are accounting records of the studio. Which retention applies
   on member erasure: anonymise `user_id` or keep it, and for how long? Needs counsel.
9. **Provider 2:** confirm Mollie before GoCardless, or wait for a studio to ask.

## References

- Code: `packages/billing/src/{service,studio-checkout,stripe-client,stripe-effects,webhook}.ts`,
  `packages/api/src/routes/billing.ts`, `packages/api/src/adapters/billing-deps.ts`,
  `packages/api/src/workers/billing.ts`, `packages/api/wrangler.billing.toml`.
- Migrations `0010_stripe_webhook_events.sql`, `0036_billing_runtime.sql`.
- Runbooks: [billing.md](../runbooks/billing.md), [stripe-production.md](../runbooks/stripe-production.md),
  [rgpd-export.md](../runbooks/rgpd-export.md); [idempotency audit](../security/idempotency-audit.md).
- Stripe: [SaaS connected accounts](https://docs.stripe.com/connect/saas/tasks/create),
  [onboarding](https://docs.stripe.com/connect/saas/tasks/onboard),
  [direct charges](https://docs.stripe.com/connect/direct-charges),
  [subscriptions with Connect](https://docs.stripe.com/connect/subscriptions),
  [Connect webhooks](https://docs.stripe.com/connect/webhooks),
  [v2 Account events](https://docs.stripe.com/api/v2/core/accounts/event-types).

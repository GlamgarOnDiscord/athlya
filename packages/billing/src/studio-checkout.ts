/**
 * Studio "pro" subscription checkout on the platform Stripe account
 * (issue #122). Redirect URLs are built server-side from a configured
 * origin (CWE-601, issue #241); the studio and the initiating admin are
 * stamped as metadata on the session and the subscription so every
 * later webhook can be attributed.
 */

import type { StudioStripeClient } from './stripe-client.js';

const STRIPE_SESSION_ID_TEMPLATE = '{CHECKOUT_SESSION_ID}';

export interface StudioCheckoutInput {
  readonly studioId: string;
  readonly userId: string;
  readonly email: string;
  /** Request-scoped key so a retried request reuses the same session. */
  readonly idempotencyKey: string;
}

export interface StudioCheckoutDeps {
  readonly stripe: StudioStripeClient;
  readonly priceId: string;
  /** Absolute origin of the studio app, e.g. `https://studio.athlya.app`. */
  readonly redirectBaseUrl: string;
}

export async function createStudioCheckout(
  input: StudioCheckoutInput,
  deps: StudioCheckoutDeps,
): Promise<{ readonly sessionId: string; readonly url: string }> {
  const origin = new URL(deps.redirectBaseUrl).origin;
  const session = await deps.stripe.createSubscriptionCheckout({
    priceId: deps.priceId,
    successUrl: `${origin}/billing/success?session_id=${STRIPE_SESSION_ID_TEMPLATE}`,
    cancelUrl: `${origin}/billing/cancel`,
    customerEmail: input.email,
    clientReferenceId: input.studioId,
    metadata: { studioId: input.studioId, userId: input.userId },
    idempotencyKey: input.idempotencyKey,
  });
  return { sessionId: session.id, url: session.url };
}

/**
 * `fetch`-based Stripe client for the studio subscription checkout
 * (issue #122). Workers-friendly: no Node SDK, one form-encoded POST.
 *
 * The returned session URL is validated before it is handed to the
 * browser: it must be an `https://checkout.stripe.com/...` URL, so a
 * compromised or misrouted response can never redirect an admin to an
 * arbitrary origin.
 */

/** Parameters of a subscription-mode Checkout Session on the platform account. */
export interface SubscriptionCheckoutParams {
  readonly priceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly customerEmail: string;
  /** Becomes `client_reference_id` (the studio id). */
  readonly clientReferenceId: string;
  /** Copied onto the session AND the subscription so later events correlate. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Stripe `Idempotency-Key`: retries of the same request create one session. */
  readonly idempotencyKey: string;
}

export interface SubscriptionCheckoutSession {
  readonly id: string;
  readonly url: string;
}

export interface StudioStripeClient {
  createSubscriptionCheckout(
    params: SubscriptionCheckoutParams,
  ): Promise<SubscriptionCheckoutSession>;
}

/** Thrown for any non-2xx Stripe response or an unexpected body. */
export class StripeApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly stripeCode: string | null,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

export const STRIPE_API_BASE = 'https://api.stripe.com';
const CHECKOUT_HOST = 'checkout.stripe.com';

/** `application/x-www-form-urlencoded` body in Stripe's bracket notation. */
export function encodeCheckoutForm(params: SubscriptionCheckoutParams): URLSearchParams {
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', params.priceId);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', params.successUrl);
  form.set('cancel_url', params.cancelUrl);
  form.set('customer_email', params.customerEmail);
  form.set('client_reference_id', params.clientReferenceId);
  for (const [key, value] of Object.entries(params.metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`subscription_data[metadata][${key}]`, value);
  }
  return form;
}

/** Accept only `https://checkout.stripe.com/...` session URLs. */
export function assertStripeCheckoutUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new StripeApiError('Stripe returned no checkout URL', 502, null);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StripeApiError('Stripe returned a malformed checkout URL', 502, null);
  }
  if (url.protocol !== 'https:' || url.hostname !== CHECKOUT_HOST) {
    throw new StripeApiError(`unexpected checkout URL host: ${url.hostname}`, 502, null);
  }
  return url.toString();
}

export function createFetchStripeClient(options: {
  readonly secretKey: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  readonly timeoutMs?: number;
}): StudioStripeClient {
  const doFetch = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? STRIPE_API_BASE;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async createSubscriptionCheckout(params) {
      const res = await doFetch(`${apiBase}/v1/checkout/sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': params.idempotencyKey,
        },
        body: encodeCheckoutForm(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: unknown;
        url?: unknown;
        error?: { message?: unknown; code?: unknown };
      } | null;
      if (!res.ok) {
        const message =
          typeof body?.error?.message === 'string'
            ? body.error.message
            : `HTTP ${String(res.status)}`;
        const code = typeof body?.error?.code === 'string' ? body.error.code : null;
        throw new StripeApiError(`Stripe checkout failed: ${message}`, res.status, code);
      }
      if (typeof body?.id !== 'string' || !body.id.startsWith('cs_')) {
        throw new StripeApiError('Stripe returned no checkout session id', 502, null);
      }
      return { id: body.id, url: assertStripeCheckoutUrl(body.url) };
    },
  };
}

import { describe, expect, it, vi } from 'vitest';

import {
  StripeApiError,
  assertStripeCheckoutUrl,
  createFetchStripeClient,
  encodeCheckoutForm,
} from '../stripe-client.js';
import { PAYMENT_FAILED_REASON, mapStripeEvent } from '../stripe-effects.js';
import { createStudioCheckout } from '../studio-checkout.js';
import { handleStripeWebhook, type WebhookDeps } from '../webhook.js';

/** Issue #122 — operational studio billing. */

const STUDIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = '11111111-1111-4111-8111-111111111113';
const fixedId = () => '0193f000-0000-7000-8000-000000000122';
const fixedNow = () => new Date('2026-10-12T00:00:00.000Z');

describe('Stripe checkout client', () => {
  const params = {
    priceId: 'price_pro',
    successUrl: 'https://studio.athlya.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://studio.athlya.test/billing/cancel',
    customerEmail: 'admin@athlya.test',
    clientReferenceId: STUDIO,
    metadata: { studioId: STUDIO, userId: ADMIN },
    idempotencyKey: 'idem-1',
  };

  it('encodes a subscription session with metadata on session and subscription', () => {
    const form = encodeCheckoutForm(params);
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_pro');
    expect(form.get('client_reference_id')).toBe(STUDIO);
    expect(form.get('metadata[studioId]')).toBe(STUDIO);
    expect(form.get('subscription_data[metadata][userId]')).toBe(ADMIN);
  });

  it('posts with the secret, idempotency key and timeout, and returns the session', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
      ),
    );
    const client = createFetchStripeClient({ secretKey: 'sk_test_x', fetch: fetchMock });

    await expect(client.createSubscriptionCheckout(params)).resolves.toEqual({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_x');
    expect(headers['idempotency-key']).toBe('idem-1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces Stripe errors with status and code', async () => {
    const client = createFetchStripeClient({
      secretKey: 'sk_test_x',
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { message: 'No such price', code: 'resource_missing' } },
            { status: 400 },
          ),
        ),
    });
    await expect(client.createSubscriptionCheckout(params)).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 400,
      stripeCode: 'resource_missing',
    });
  });

  it.each([
    'http://checkout.stripe.com/c/pay/x',
    'https://evil.example/c/pay/x',
    'https://checkout.stripe.com.evil.example/x',
    'not a url',
    undefined,
  ])('refuses the checkout URL %j', (url) => {
    expect(() => assertStripeCheckoutUrl(url)).toThrow(StripeApiError);
  });

  it('builds redirect URLs from the configured origin only', async () => {
    const createSubscriptionCheckout = vi.fn(() =>
      Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
    );
    await createStudioCheckout(
      { studioId: STUDIO, userId: ADMIN, email: 'a@athlya.test', idempotencyKey: 'k' },
      {
        stripe: { createSubscriptionCheckout },
        priceId: 'price_pro',
        redirectBaseUrl: 'https://studio.athlya.test/some/path?x=1',
      },
    );
    expect(createSubscriptionCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl: 'https://studio.athlya.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://studio.athlya.test/billing/cancel',
        metadata: { studioId: STUDIO, userId: ADMIN },
      }),
    );
  });
});

describe('mapStripeEvent', () => {
  const ev = (type: string, object: unknown) => ({ id: 'evt_1', type, data: { object } });

  it('checkout.session.completed links the subscription to the studio and admin', () => {
    const effect = mapStripeEvent(
      ev('checkout.session.completed', {
        mode: 'subscription',
        subscription: 'sub_1',
        customer: 'cus_1',
        payment_status: 'paid',
        metadata: { studioId: STUDIO, userId: ADMIN },
      }),
      fixedId,
      fixedNow,
    );
    expect(effect).toMatchObject({
      studioId: STUDIO,
      userId: ADMIN,
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      event: null,
    });
  });

  it('customer.subscription.created emits a schema-shaped billing.subscription.started', () => {
    const effect = mapStripeEvent(
      ev('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        start_date: 1_760_227_200,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_762_905_600 }] },
        metadata: { studioId: STUDIO, userId: ADMIN },
      }),
      fixedId,
      fixedNow,
    );
    expect(effect?.subscription).toMatchObject({
      priceId: 'price_pro',
      currentPeriodEnd: new Date(1_762_905_600_000).toISOString(),
    });
    expect(effect?.event).toEqual({
      id: fixedId(),
      type: 'billing.subscription.started',
      occurredAt: fixedNow().toISOString(),
      payload: {
        subscriptionId: 'sub_1',
        plan: 'pro',
        startsAt: new Date(1_760_227_200_000).toISOString(),
      },
    });
  });

  it('customer.subscription.deleted cancels without an event', () => {
    const effect = mapStripeEvent(
      ev('customer.subscription.deleted', { id: 'sub_1', status: 'active' }),
      fixedId,
    );
    expect(effect?.subscription?.status).toBe('canceled');
    expect(effect?.event).toBeNull();
  });

  it('invoice.payment_failed records the invoice and a dunning event (new API shape)', () => {
    const effect = mapStripeEvent(
      ev('invoice.payment_failed', {
        id: 'in_1',
        status: 'open',
        amount_due: 4900,
        currency: 'EUR',
        created: 1_760_227_200,
        number: 'A-1',
        hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
        parent: { subscription_details: { subscription: 'sub_1' } },
      }),
      fixedId,
      fixedNow,
    );
    expect(effect?.invoice).toMatchObject({
      stripeInvoiceId: 'in_1',
      stripeSubscriptionId: 'sub_1',
      currency: 'eur',
      amountDue: 4900,
    });
    expect(effect?.event).toMatchObject({
      type: 'billing.subscription.failed',
      payload: { subscriptionId: 'sub_1', reason: PAYMENT_FAILED_REASON },
    });
  });

  it('ignores last_finalization_error, which is not a payment decline', () => {
    const effect = mapStripeEvent(
      ev('invoice.payment_failed', {
        id: 'in_1',
        status: 'open',
        amount_due: 4900,
        currency: 'eur',
        created: 1_760_227_200,
        subscription: 'sub_1',
        last_finalization_error: { message: 'tax_id_invalid' },
      }),
      fixedId,
      fixedNow,
    );
    expect(effect?.event?.payload['reason']).toBe(PAYMENT_FAILED_REASON);
  });

  it('carries the Stripe event time so late older deliveries are ordered', () => {
    const effect = mapStripeEvent(
      {
        ...ev('customer.subscription.updated', { id: 'sub_1', status: 'active' }),
        created: 1_760_227_200,
      },
      fixedId,
    );
    expect(effect?.sourceEventAt).toBe('2025-10-12T00:00:00.000Z');
    expect(
      mapStripeEvent(
        ev('customer.subscription.updated', { id: 'sub_1', status: 'active' }),
        fixedId,
      )?.sourceEventAt,
    ).toBeNull();
  });

  it.each([
    ['unknown type', ev('charge.updated', { id: 'ch_1' })],
    ['payment-mode checkout', ev('checkout.session.completed', { mode: 'payment' })],
    [
      'invoice with bogus status',
      ev('invoice.paid', {
        id: 'in_1',
        status: 'weird',
        amount_due: 1,
        currency: 'eur',
        created: 1,
      }),
    ],
    [
      'invoice with negative amount',
      ev('invoice.paid', {
        id: 'in_1',
        status: 'paid',
        amount_due: -1,
        currency: 'eur',
        created: 1,
      }),
    ],
    ['no data.object', { id: 'evt', type: 'invoice.paid', data: null }],
  ])('ignores %s', (_label, event) => {
    expect(mapStripeEvent(event, fixedId)).toBeNull();
  });

  it('drops a non-https hosted invoice URL and malformed metadata ids', () => {
    const effect = mapStripeEvent(
      ev('checkout.session.completed', {
        mode: 'subscription',
        subscription: 'sub_1',
        metadata: { studioId: 'not-a-uuid', userId: ADMIN },
        client_reference_id: STUDIO,
      }),
      fixedId,
    );
    expect(effect?.studioId).toBe(STUDIO);
    const invoice = mapStripeEvent(
      ev('invoice.paid', {
        id: 'in_1',
        status: 'paid',
        amount_due: 1,
        currency: 'eur',
        created: 1,
        hosted_invoice_url: 'javascript:alert(1)',
      }),
      fixedId,
    );
    expect(invoice?.invoice?.hostedInvoiceUrl).toBeNull();
  });
});

describe('handleStripeWebhook — atomic applyEvent path', () => {
  function deps(applyEvent: WebhookDeps['applyEvent']): WebhookDeps {
    return {
      verifySignature: () =>
        Promise.resolve({
          ok: true as const,
          event: { id: 'evt_1', type: 'invoice.paid', data: {} },
        }),
      appendAudit: vi.fn(() => Promise.resolve()),
      withTransaction: async (fn) => fn(),
      applyEvent,
    };
  }

  it('delegates to applyEvent and writes no separate audit', async () => {
    const d = deps(() => Promise.resolve('applied' as const));
    await expect(handleStripeWebhook('{}', 'sig', 'whsec', d)).resolves.toEqual({
      kind: 'processed',
      eventType: 'invoice.paid',
      eventId: 'evt_1',
    });
    expect(d.appendAudit).not.toHaveBeenCalled();
  });

  it('acknowledges duplicates and ignored events', async () => {
    await expect(
      handleStripeWebhook(
        '{}',
        'sig',
        'whsec',
        deps(() => Promise.resolve('duplicate' as const)),
      ),
    ).resolves.toMatchObject({ kind: 'processed' });
    await expect(
      handleStripeWebhook(
        '{}',
        'sig',
        'whsec',
        deps(() => Promise.resolve('ignored' as const)),
      ),
    ).resolves.toEqual({ kind: 'unknown_event_type', eventType: 'invoice.paid' });
  });

  it('propagates an application failure so Stripe retries', async () => {
    await expect(
      handleStripeWebhook(
        '{}',
        'sig',
        'whsec',
        deps(() => Promise.reject(new Error('db down'))),
      ),
    ).rejects.toThrow('db down');
  });
});

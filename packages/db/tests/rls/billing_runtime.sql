-- =====================================================================
-- billing_runtime.sql — Stripe webhook application (issue #122)
--
-- The webhook route runs as athlya_app with no tenant claims. The claim,
-- the billing state change, the outbox event and the audit row are one
-- statement: a failure rolls the claim back so Stripe's retry is
-- processed, and a replay is a no-op.
-- =====================================================================

BEGIN;
SELECT plan(14);

SET LOCAL ROLE athlya_app;

SELECT ok(
    billing_apply_stripe_event('evt_122_checkout', 'checkout.session.completed', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'userId', '11111111-1111-4111-8111-111111111113',
        'subscription', jsonb_build_object(
            'stripeSubscriptionId', 'sub_122', 'stripeCustomerId', 'cus_122',
            'status', 'active', 'priceId', 'price_pro',
            'currentPeriodEnd', '2026-11-12T00:00:00Z', 'cancelAtPeriodEnd', false),
        'event', jsonb_build_object(
            'id', 'evt-athlya-122-started', 'type', 'billing.subscription.started',
            'occurredAt', '2026-10-12T00:00:00Z',
            'payload', jsonb_build_object('subscriptionId', 'sub_122', 'plan', 'pro',
                                          'startsAt', '2026-10-12T00:00:00Z')))),
    'checkout.session.completed is applied once'
);

SELECT ok(
    NOT billing_apply_stripe_event('evt_122_checkout', 'checkout.session.completed', '{}'::jsonb),
    'a replayed Stripe event is a no-op'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT studio_id, status, initiated_by FROM studio_subscriptions WHERE stripe_subscription_id = 'sub_122' $$,
    $$ VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'active'::text,
               '11111111-1111-4111-8111-111111111113'::uuid) $$,
    'the studio subscription is persisted'
);

SELECT results_eq(
    $$ SELECT payload->'payload'->>'userId', studio_id, published_at IS NULL
         FROM outbox WHERE event_id = 'evt-athlya-122-started' $$,
    $$ VALUES ('11111111-1111-4111-8111-111111111113'::text,
               'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, true) $$,
    'billing.subscription.started is in the outbox with its recipient'
);

SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE target_id = 'evt_122_checkout' AND action = 'billing.webhook.processed'),
    1,
    'exactly one audit row for the processed event'
);

SET LOCAL ROLE athlya_app;

-- Invoice events carry no Athlya metadata: studio and recipient are
-- resolved from the known subscription.
SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_failed', 'invoice.payment_failed', jsonb_build_object(
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122', 'stripeSubscriptionId', 'sub_122', 'number', 'A-0001',
            'status', 'open', 'amountDue', 4900, 'currency', 'EUR',
            'hostedInvoiceUrl', 'https://invoice.stripe.com/i/in_122',
            'createdAt', '2026-10-12T00:00:00Z'),
        'event', jsonb_build_object(
            'id', 'evt-athlya-122-failed', 'type', 'billing.subscription.failed',
            'occurredAt', '2026-10-12T00:00:00Z',
            'payload', jsonb_build_object('subscriptionId', 'sub_122', 'reason', 'card_declined')))),
    'invoice.payment_failed resolves its studio from the subscription'
);

SELECT results_eq(
    $$ SELECT stripe_invoice_id, status, amount_due, currency::text
         FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, 20) $$,
    $$ VALUES ('in_122'::text, 'open'::text, 4900, 'eur'::text) $$,
    'billing_list_invoices pages the studio invoices'
);

SELECT is_empty(
    $$ SELECT * FROM billing_list_invoices('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, NULL, 20) $$,
    'another studio sees none of them'
);

SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_paid', 'invoice.paid', jsonb_build_object(
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122', 'stripeSubscriptionId', 'sub_122', 'number', 'A-0001',
            'status', 'paid', 'amountDue', 4900, 'currency', 'eur',
            'hostedInvoiceUrl', NULL, 'createdAt', '2026-10-12T00:00:00Z'))),
    'invoice.paid updates the same invoice'
);

SELECT results_eq(
    $$ SELECT status, hosted_invoice_url FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, 20) $$,
    $$ VALUES ('paid'::text, 'https://invoice.stripe.com/i/in_122'::text) $$,
    'invoice upsert keeps the known hosted URL'
);

-- Post-claim failure: the whole statement rolls back, claim included.
SELECT throws_ok(
    $$ SELECT billing_apply_stripe_event('evt_122_broken', 'invoice.paid', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'invoice', jsonb_build_object('stripeInvoiceId', 'in_bad', 'status', 'bogus',
                                      'amountDue', 1, 'currency', 'eur', 'createdAt', '2026-10-12T00:00:00Z'))) $$,
    '23514',
    NULL,
    'an invalid change fails the statement'
);

SELECT ok(
    billing_apply_stripe_event('evt_122_broken', 'invoice.paid', '{}'::jsonb),
    'the failed event was not claimed: Stripe''s retry is processed'
);

-- RLS on the new tables for direct reads.
SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
SELECT set_config('app.studio_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.role', 'member', true);
SELECT is(
    (SELECT count(*)::int FROM studio_subscriptions) + (SELECT count(*)::int FROM studio_invoices),
    0,
    'studio_subscriptions_read_admin + studio_invoices_read_admin: members do not see billing state'
);

SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111113', true);
SELECT set_config('app.role', 'admin', true);
SELECT is(
    (SELECT count(*)::int FROM studio_subscriptions) + (SELECT count(*)::int FROM studio_invoices),
    2,
    'studio_subscriptions_read_admin + studio_invoices_read_admin: the studio admin sees its subscription and invoice'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;

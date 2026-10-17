-- =====================================================================
-- billing_runtime.sql — Stripe webhook application (issue #122)
--
-- The webhook runs as athlya_billing with no tenant claims; it is the
-- only role allowed to apply Stripe events. The claim, the billing state
-- change, the outbox event and the audit row are one statement: a
-- failure rolls the claim back so Stripe's retry is processed, and a
-- replay is a no-op. Invoice listing runs as athlya_app under RLS.
-- =====================================================================

BEGIN;
SELECT plan(28);

-- ---------- privileges ----------

SELECT ok(
    has_function_privilege('athlya_billing', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_app', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_cron', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('public', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE'),
    'billing_apply_stripe_event: executable by athlya_billing only'
);

SELECT ok(
    (SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'athlya_owner'
            AND 'search_path=public, pg_temp' = ANY (p.proconfig)
       FROM pg_proc p WHERE p.oid = 'billing_apply_stripe_event(text, text, jsonb)'::regprocedure),
    'billing_apply_stripe_event: SECURITY DEFINER owned by athlya_owner with a pinned search_path'
);

SELECT ok(
    (SELECT NOT p.prosecdef FROM pg_proc p
      WHERE p.oid = 'billing_list_invoices(uuid, timestamptz, uuid, integer)'::regprocedure)
    AND has_function_privilege('athlya_app', 'billing_list_invoices(uuid, timestamptz, uuid, integer)', 'EXECUTE')
    AND NOT has_function_privilege('athlya_billing', 'billing_list_invoices(uuid, timestamptz, uuid, integer)', 'EXECUTE'),
    'billing_list_invoices: SECURITY INVOKER, granted to athlya_app only'
);

SELECT ok(
    (SELECT NOT rolbypassrls AND NOT rolsuper FROM pg_roles WHERE rolname = 'athlya_billing'),
    'athlya_billing is NOBYPASSRLS'
);

SET LOCAL ROLE athlya_app;
SELECT throws_ok(
    $$ SELECT billing_apply_stripe_event('evt_122_forged', 'customer.subscription.created', '{}'::jsonb) $$,
    '42501',
    NULL,
    'athlya_app cannot forge a Stripe event'
);
RESET ROLE;

-- ---------- application ----------

SET LOCAL ROLE athlya_billing;

SELECT ok(
    billing_apply_stripe_event('evt_122_checkout', 'checkout.session.completed', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'userId', '11111111-1111-4111-8111-111111111113',
        'sourceEventAt', '2026-10-12T00:00:00Z',
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

-- An older subscription event delivered late does not roll the status back.
SELECT ok(
    billing_apply_stripe_event('evt_122_sub_created_late', 'customer.subscription.created', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'sourceEventAt', '2026-10-11T23:59:00Z',
        'subscription', jsonb_build_object(
            'stripeSubscriptionId', 'sub_122', 'status', 'incomplete', 'priceId', 'price_old',
            'cancelAtPeriodEnd', false))),
    'a late older subscription event is accepted'
);

RESET ROLE;

SELECT results_eq(
    $$ SELECT studio_id, status, initiated_by, price_id FROM studio_subscriptions WHERE stripe_subscription_id = 'sub_122' $$,
    $$ VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'active'::text,
               '11111111-1111-4111-8111-111111111113'::uuid, 'price_pro'::text) $$,
    'the studio subscription is persisted and keeps the newest status'
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

SET LOCAL ROLE athlya_billing;

-- Metadata studio of a subscription Athlya has not stored yet is kept
-- even though the subscription lookup finds no row.
SELECT ok(
    billing_apply_stripe_event('evt_122_meta_only', 'customer.subscription.updated', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'sourceEventAt', '2026-10-12T00:00:00Z',
        'subscription', jsonb_build_object(
            'stripeSubscriptionId', 'sub_122_meta', 'status', 'active', 'cancelAtPeriodEnd', false))),
    'a subscription event with only the studio in its metadata is applied'
);

-- Invoice events carry no Athlya metadata: studio and recipient are
-- resolved from the known subscription.
SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_failed', 'invoice.payment_failed', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:00:00Z',
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

SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_paid', 'invoice.paid', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:05:00Z',
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122', 'stripeSubscriptionId', 'sub_122', 'number', 'A-0001',
            'status', 'paid', 'amountDue', 4900, 'currency', 'eur',
            'hostedInvoiceUrl', NULL, 'createdAt', '2026-10-12T00:00:00Z'))),
    'invoice.paid updates the same invoice'
);

-- Retried older events never reopen a settled invoice, including an
-- event Stripe stamped with the same second.
SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_finalized_late', 'invoice.finalized', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:01:00Z',
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122', 'stripeSubscriptionId', 'sub_122',
            'status', 'open', 'amountDue', 4900, 'currency', 'eur',
            'createdAt', '2026-10-12T00:00:00Z'))),
    'a late older invoice event is accepted'
);

SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_updated_same_second', 'invoice.updated', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:05:00Z',
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122', 'stripeSubscriptionId', 'sub_122',
            'status', 'open', 'amountDue', 4900, 'currency', 'eur',
            'createdAt', '2026-10-12T00:00:00Z'))),
    'an invoice event stamped with the same second is accepted'
);

-- Stripe does not order deliveries: an invoice of a subscription not
-- recorded yet fails, and is NOT claimed, so Stripe's retry applies it.
SELECT throws_ok(
    $$ SELECT billing_apply_stripe_event('evt_122_invoice_early', 'invoice.paid', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:00:00Z',
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122_early', 'stripeSubscriptionId', 'sub_122_late',
            'status', 'paid', 'amountDue', 4900, 'currency', 'eur',
            'createdAt', '2026-10-12T00:00:00Z'))) $$,
    '55000',
    NULL,
    'an invoice of an unknown subscription is rejected'
);

SELECT ok(
    billing_apply_stripe_event('evt_122_sub_late', 'customer.subscription.created', jsonb_build_object(
        'studioId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'sourceEventAt', '2026-10-12T00:00:00Z',
        'subscription', jsonb_build_object(
            'stripeSubscriptionId', 'sub_122_late', 'status', 'active', 'cancelAtPeriodEnd', false))),
    'the subscription is recorded afterwards'
);

SELECT ok(
    billing_apply_stripe_event('evt_122_invoice_early', 'invoice.paid', jsonb_build_object(
        'sourceEventAt', '2026-10-12T00:00:00Z',
        'invoice', jsonb_build_object(
            'stripeInvoiceId', 'in_122_early', 'stripeSubscriptionId', 'sub_122_late',
            'status', 'paid', 'amountDue', 4900, 'currency', 'eur',
            'createdAt', '2026-10-11T00:00:00Z'))),
    'Stripe''s retry of the early invoice is applied'
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

RESET ROLE;

SELECT results_eq(
    $$ SELECT status, hosted_invoice_url FROM studio_invoices WHERE stripe_invoice_id = 'in_122' $$,
    $$ VALUES ('paid'::text, 'https://invoice.stripe.com/i/in_122'::text) $$,
    'the invoice stays paid and keeps the known hosted URL'
);

-- ---------- listing (athlya_app, RLS) ----------

SET LOCAL ROLE athlya_app;
SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111113', true);
SELECT set_config('app.studio_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.role', 'admin', true);

SELECT results_eq(
    $$ SELECT stripe_invoice_id, status, amount_due, currency
         FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, 20) $$,
    $$ VALUES ('in_122'::text, 'paid'::text, 4900, 'eur'::text),
              ('in_122_early'::text, 'paid'::text, 4900, 'eur'::text) $$,
    'billing_list_invoices pages the studio invoices for its admin'
);

SELECT results_eq(
    $$ SELECT stripe_invoice_id FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
           '2026-10-12T00:00:00Z', (SELECT id FROM studio_invoices WHERE stripe_invoice_id = 'in_122'), 20) $$,
    $$ VALUES ('in_122_early'::text) $$,
    'billing_list_invoices continues after the keyset cursor'
);

SELECT set_config('app.user_id', '22222222-2222-4222-8222-222222222222', true);
SELECT set_config('app.studio_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
SELECT is_empty(
    $$ SELECT * FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, 20) $$,
    'another studio''s admin cannot list them by passing their studio id'
);

SELECT set_config('app.user_id', '', true);
SELECT set_config('app.studio_id', '', true);
SELECT set_config('app.role', '', true);
SELECT is_empty(
    $$ SELECT * FROM billing_list_invoices('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, 20) $$,
    'without tenant claims the listing is empty'
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
    5,
    'studio_subscriptions_read_admin + studio_invoices_read_admin: the studio admin sees its subscriptions and invoices'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;

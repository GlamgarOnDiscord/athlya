-- =====================================================================
-- 0036 — operational studio billing (issue #122)
--
-- Studios subscribe to the Athlya "pro" plan through Stripe Checkout on
-- the platform account. Until now the webhook only claimed the Stripe
-- event and published a no-op, so no subscription or invoice state ever
-- existed, and a failure after the claim made Stripe's retry look like
-- a duplicate (the event was lost).
--
--   - studio_subscriptions / studio_invoices: billing state per studio,
--     readable by that studio's admins only (RLS).
--   - billing_apply_stripe_event: ONE statement claims the Stripe event,
--     applies the subscription / invoice change, records the domain
--     event in the outbox and appends the audit row. Any failure rolls
--     the claim back, so Stripe's retry is processed instead of being
--     discarded as a duplicate.
--   - billing_list_invoices: keyset page of a studio's invoices for the
--     admin route (the caller's role/studio are checked by the API).
--
-- Additive only — new tables and functions, canary safe.
-- =====================================================================

CREATE TABLE IF NOT EXISTS "studio_subscriptions" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "stripe_subscription_id" text NOT NULL UNIQUE,
    "stripe_customer_id" text,
    "status" text NOT NULL,
    "price_id" text,
    "current_period_end" timestamptz,
    "cancel_at_period_end" boolean NOT NULL DEFAULT false,
    "initiated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_subscriptions_studio_idx" ON "studio_subscriptions" ("studio_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "studio_invoices" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "stripe_invoice_id" text NOT NULL UNIQUE,
    "stripe_subscription_id" text,
    "number" text,
    "status" text NOT NULL CHECK ("status" IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
    "amount_due" integer NOT NULL CHECK ("amount_due" >= 0),
    "currency" char(3) NOT NULL,
    "hosted_invoice_url" text,
    "created_at" timestamptz NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_invoices_studio_page_idx"
    ON "studio_invoices" ("studio_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

ALTER TABLE "studio_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "studio_subscriptions_read_admin" ON "studio_subscriptions";--> statement-breakpoint
CREATE POLICY "studio_subscriptions_read_admin" ON "studio_subscriptions"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "studio_invoices_read_admin" ON "studio_invoices";--> statement-breakpoint
CREATE POLICY "studio_invoices_read_admin" ON "studio_invoices"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        GRANT SELECT ON "studio_subscriptions", "studio_invoices" TO athlya_app;
    END IF;
END
$$;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "studio_subscriptions", "studio_invoices" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON "stripe_webhook_events" TO athlya_owner;--> statement-breakpoint

-- p_effect (built and validated by @athlya/billing):
--   { "studioId": uuid|null, "userId": uuid|null,
--     "subscription": { stripeSubscriptionId, stripeCustomerId, status, priceId,
--                       currentPeriodEnd, cancelAtPeriodEnd } | null,
--     "invoice": { stripeInvoiceId, stripeSubscriptionId, number, status,
--                  amountDue, currency, hostedInvoiceUrl, createdAt } | null,
--     "event": Athlya envelope { id, type, occurredAt, payload } | null }
-- Returns false when the Stripe event was already applied (duplicate).
CREATE OR REPLACE FUNCTION billing_apply_stripe_event(
    p_event_id text,
    p_event_type text,
    p_effect jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_claimed integer;
    v_sub jsonb := p_effect->'subscription';
    v_inv jsonb := p_effect->'invoice';
    v_event jsonb := p_effect->'event';
    v_studio uuid := NULLIF(p_effect->>'studioId', '')::uuid;
    v_user uuid := NULLIF(p_effect->>'userId', '')::uuid;
    v_sub_id text := COALESCE(v_sub->>'stripeSubscriptionId', v_inv->>'stripeSubscriptionId');
BEGIN
    IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255 THEN
        RAISE EXCEPTION 'invalid Stripe event id' USING ERRCODE = '22023';
    END IF;

    INSERT INTO stripe_webhook_events (event_id, event_type)
    VALUES (p_event_id, p_event_type)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
        RETURN false;
    END IF;

    -- Events without metadata (invoices, later subscription updates)
    -- resolve their studio / initiating admin from the known subscription.
    IF v_sub_id IS NOT NULL AND (v_studio IS NULL OR v_user IS NULL) THEN
        SELECT COALESCE(v_studio, s.studio_id), COALESCE(v_user, s.initiated_by)
          INTO v_studio, v_user
          FROM studio_subscriptions s
         WHERE s.stripe_subscription_id = v_sub_id;
    END IF;
    IF v_studio IS NOT NULL AND NOT EXISTS (SELECT 1 FROM studios WHERE id = v_studio) THEN
        v_studio := NULL;
    END IF;
    IF v_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = v_user) THEN
        v_user := NULL;
    END IF;

    IF v_sub IS NOT NULL AND jsonb_typeof(v_sub) = 'object' AND v_studio IS NOT NULL THEN
        INSERT INTO studio_subscriptions AS s (
            studio_id, stripe_subscription_id, stripe_customer_id, status, price_id,
            current_period_end, cancel_at_period_end, initiated_by
        ) VALUES (
            v_studio,
            v_sub->>'stripeSubscriptionId',
            v_sub->>'stripeCustomerId',
            v_sub->>'status',
            v_sub->>'priceId',
            (v_sub->>'currentPeriodEnd')::timestamptz,
            COALESCE((v_sub->>'cancelAtPeriodEnd')::boolean, false),
            v_user
        )
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET
            stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, s.stripe_customer_id),
            status = EXCLUDED.status,
            price_id = COALESCE(EXCLUDED.price_id, s.price_id),
            current_period_end = COALESCE(EXCLUDED.current_period_end, s.current_period_end),
            cancel_at_period_end = EXCLUDED.cancel_at_period_end,
            initiated_by = COALESCE(s.initiated_by, EXCLUDED.initiated_by),
            updated_at = now();
    END IF;

    IF v_inv IS NOT NULL AND jsonb_typeof(v_inv) = 'object' AND v_studio IS NOT NULL THEN
        INSERT INTO studio_invoices AS i (
            studio_id, stripe_invoice_id, stripe_subscription_id, number, status,
            amount_due, currency, hosted_invoice_url, created_at
        ) VALUES (
            v_studio,
            v_inv->>'stripeInvoiceId',
            v_inv->>'stripeSubscriptionId',
            v_inv->>'number',
            v_inv->>'status',
            (v_inv->>'amountDue')::integer,
            lower(v_inv->>'currency'),
            v_inv->>'hostedInvoiceUrl',
            (v_inv->>'createdAt')::timestamptz
        )
        ON CONFLICT (stripe_invoice_id) DO UPDATE SET
            number = COALESCE(EXCLUDED.number, i.number),
            status = EXCLUDED.status,
            amount_due = EXCLUDED.amount_due,
            hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, i.hosted_invoice_url),
            updated_at = now();
    END IF;

    -- The bus contract requires the recipient user; without one (unknown
    -- studio / admin deleted) the state change still lands, no event.
    IF v_event IS NOT NULL AND jsonb_typeof(v_event) = 'object' AND v_user IS NOT NULL THEN
        v_event := jsonb_set(v_event, '{payload,userId}', to_jsonb(v_user::text));
        IF v_studio IS NOT NULL THEN
            v_event := jsonb_set(v_event, '{studioId}', to_jsonb(v_studio::text));
        END IF;
        INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
        VALUES (v_event->>'id', v_event->>'type', v_event, (v_event->>'occurredAt')::timestamptz, v_studio)
        ON CONFLICT (event_id) DO NOTHING;
    END IF;

    INSERT INTO audit_log (actor_id, action, target_type, target_id, metadata, studio_id)
    VALUES (NULL, 'billing.webhook.processed', 'stripe_webhook', p_event_id,
            jsonb_build_object('eventType', p_event_type, 'applied', v_studio IS NOT NULL),
            v_studio);

    RETURN true;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_list_invoices(
    p_studio_id uuid,
    p_before_created timestamptz,
    p_before_id uuid,
    p_limit integer
)
RETURNS TABLE (
    id uuid,
    stripe_invoice_id text,
    number text,
    status text,
    amount_due integer,
    currency text,
    hosted_invoice_url text,
    created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT i.id, i.stripe_invoice_id, i.number, i.status, i.amount_due, i.currency::text,
           i.hosted_invoice_url, i.created_at
      FROM studio_invoices i
     WHERE i.studio_id = p_studio_id
       AND (p_before_created IS NULL OR (i.created_at, i.id) < (p_before_created, p_before_id))
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 101)
$$;
--> statement-breakpoint

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'billing_apply_stripe_event(text, text, jsonb)',
        'billing_list_invoices(uuid, timestamptz, uuid, integer)'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO athlya_owner', fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO athlya_app', fn);
        END IF;
    END LOOP;
END
$$;

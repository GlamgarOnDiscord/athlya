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
--   - athlya_billing: dedicated runtime role of the Stripe webhook. It
--     is the ONLY role allowed to apply Stripe events; athlya_app (every
--     other route) cannot forge subscriptions, invoices or bus events.
--   - billing_apply_stripe_event: ONE statement claims the Stripe event,
--     applies the subscription / invoice change, records the domain
--     event in the outbox and appends the audit row. Any failure rolls
--     the claim back, so Stripe's retry is processed instead of being
--     discarded as a duplicate.
--   - billing_list_invoices: keyset page of a studio's invoices. It runs
--     with the caller's privileges, so the studio_invoices RLS policy
--     (studio admin only) applies to it.
--
-- Additive only — new role, tables and functions, canary safe.
-- =====================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_billing') THEN
        CREATE ROLE athlya_billing NOLOGIN NOBYPASSRLS;
    END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO athlya_billing;--> statement-breakpoint

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
    -- `created` of the newest Stripe event applied to the status: an
    -- older event delivered late never rolls the status back.
    "source_event_at" timestamptz NOT NULL,
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
    "source_event_at" timestamptz NOT NULL,
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

-- Rank of an invoice status: at equal event time (Stripe often stamps
-- `invoice.finalized` and `invoice.paid` with the same second) a
-- settled invoice is never reopened by the earlier event.
CREATE OR REPLACE FUNCTION billing_invoice_status_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_status WHEN 'draft' THEN 0 WHEN 'open' THEN 1 ELSE 2 END
$$;
--> statement-breakpoint

-- p_effect (built and validated by @athlya/billing):
--   { "studioId": uuid|null, "userId": uuid|null,
--     "sourceEventAt": iso timestamp of the Stripe event (`created`) | null,
--     "subscription": { stripeSubscriptionId, stripeCustomerId, status, priceId,
--                       currentPeriodEnd, cancelAtPeriodEnd } | null,
--     "invoice": { stripeInvoiceId, stripeSubscriptionId, number, status,
--                  amountDue, currency, hostedInvoiceUrl, createdAt } | null,
--     "event": Athlya envelope { id, type, occurredAt, payload } | null }
-- Returns false when the Stripe event was already applied (duplicate).
-- Stripe does not order deliveries: every Athlya subscription and its
-- invoices carry the studio in their metadata (invoices through the
-- subscription metadata snapshot), so a change is applied even before
-- the subscription row exists. A change with no studio in its metadata
-- and no stored subscription is not Athlya's (or its studio was deleted
-- and cascaded the row): it is acknowledged, nothing is applied.
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
    v_source_at timestamptz := COALESCE(NULLIF(p_effect->>'sourceEventAt', '')::timestamptz, now());
    v_sub_id text;
BEGIN
    IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255 THEN
        RAISE EXCEPTION 'invalid Stripe event id' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_sub) IS DISTINCT FROM 'object' THEN
        v_sub := NULL;
    END IF;
    IF jsonb_typeof(v_inv) IS DISTINCT FROM 'object' THEN
        v_inv := NULL;
    END IF;
    IF jsonb_typeof(v_event) IS DISTINCT FROM 'object' THEN
        v_event := NULL;
    END IF;
    v_sub_id := COALESCE(v_sub->>'stripeSubscriptionId', v_inv->>'stripeSubscriptionId');

    INSERT INTO stripe_webhook_events (event_id, event_type)
    VALUES (p_event_id, p_event_type)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    IF v_claimed = 0 THEN
        RETURN false;
    END IF;

    -- Values missing from the event metadata are resolved from the
    -- stored subscription. Each value is filled only when still
    -- missing: a studio taken from the event metadata is never lost.
    IF v_sub_id IS NOT NULL THEN
        v_studio := COALESCE(v_studio, (
            SELECT s.studio_id FROM studio_subscriptions s WHERE s.stripe_subscription_id = v_sub_id));
        v_user := COALESCE(v_user, (
            SELECT s.initiated_by FROM studio_subscriptions s WHERE s.stripe_subscription_id = v_sub_id));
    END IF;

    -- A studio deleted since checkout: acknowledge, nothing to apply.
    IF v_studio IS NOT NULL AND NOT EXISTS (SELECT 1 FROM studios WHERE id = v_studio) THEN
        v_studio := NULL;
    END IF;
    IF v_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = v_user) THEN
        v_user := NULL;
    END IF;

    IF v_sub IS NOT NULL AND v_studio IS NOT NULL THEN
        INSERT INTO studio_subscriptions AS s (
            studio_id, stripe_subscription_id, stripe_customer_id, status, price_id,
            current_period_end, cancel_at_period_end, initiated_by, source_event_at
        ) VALUES (
            v_studio,
            v_sub->>'stripeSubscriptionId',
            v_sub->>'stripeCustomerId',
            v_sub->>'status',
            v_sub->>'priceId',
            (v_sub->>'currentPeriodEnd')::timestamptz,
            COALESCE((v_sub->>'cancelAtPeriodEnd')::boolean, false),
            v_user,
            v_source_at
        )
        ON CONFLICT (stripe_subscription_id) DO UPDATE SET
            status = CASE WHEN EXCLUDED.source_event_at >= s.source_event_at
                          THEN EXCLUDED.status ELSE s.status END,
            cancel_at_period_end = CASE WHEN EXCLUDED.source_event_at >= s.source_event_at
                                        THEN EXCLUDED.cancel_at_period_end ELSE s.cancel_at_period_end END,
            stripe_customer_id = CASE WHEN EXCLUDED.source_event_at >= s.source_event_at
                                      THEN COALESCE(EXCLUDED.stripe_customer_id, s.stripe_customer_id)
                                      ELSE COALESCE(s.stripe_customer_id, EXCLUDED.stripe_customer_id) END,
            price_id = CASE WHEN EXCLUDED.source_event_at >= s.source_event_at
                            THEN COALESCE(EXCLUDED.price_id, s.price_id)
                            ELSE COALESCE(s.price_id, EXCLUDED.price_id) END,
            current_period_end = CASE WHEN EXCLUDED.source_event_at >= s.source_event_at
                                      THEN COALESCE(EXCLUDED.current_period_end, s.current_period_end)
                                      ELSE COALESCE(s.current_period_end, EXCLUDED.current_period_end) END,
            initiated_by = COALESCE(s.initiated_by, EXCLUDED.initiated_by),
            source_event_at = GREATEST(s.source_event_at, EXCLUDED.source_event_at),
            updated_at = now();
    END IF;

    IF v_inv IS NOT NULL AND v_studio IS NOT NULL THEN
        INSERT INTO studio_invoices AS i (
            studio_id, stripe_invoice_id, stripe_subscription_id, number, status,
            amount_due, currency, hosted_invoice_url, source_event_at, created_at
        ) VALUES (
            v_studio,
            v_inv->>'stripeInvoiceId',
            v_inv->>'stripeSubscriptionId',
            v_inv->>'number',
            v_inv->>'status',
            (v_inv->>'amountDue')::integer,
            lower(v_inv->>'currency'),
            v_inv->>'hostedInvoiceUrl',
            v_source_at,
            (v_inv->>'createdAt')::timestamptz
        )
        ON CONFLICT (stripe_invoice_id) DO UPDATE SET
            status = CASE
                WHEN EXCLUDED.source_event_at > i.source_event_at
                  OR (EXCLUDED.source_event_at = i.source_event_at
                      AND billing_invoice_status_rank(EXCLUDED.status) >= billing_invoice_status_rank(i.status))
                THEN EXCLUDED.status ELSE i.status END,
            amount_due = CASE WHEN EXCLUDED.source_event_at >= i.source_event_at
                              THEN EXCLUDED.amount_due ELSE i.amount_due END,
            number = COALESCE(i.number, EXCLUDED.number),
            hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, i.hosted_invoice_url),
            source_event_at = GREATEST(i.source_event_at, EXCLUDED.source_event_at),
            updated_at = now();
    END IF;

    -- The bus contract requires the recipient user; without one (unknown
    -- studio / admin deleted) the state change still lands, no event.
    IF v_event IS NOT NULL AND v_user IS NOT NULL THEN
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

-- SECURITY INVOKER: the caller's tenant claims and the
-- studio_invoices_read_admin policy decide what is visible, so a
-- p_studio_id of another studio returns nothing.
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
SECURITY INVOKER
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
BEGIN
    ALTER FUNCTION billing_invoice_status_rank(text) OWNER TO athlya_owner;
    ALTER FUNCTION billing_apply_stripe_event(text, text, jsonb) OWNER TO athlya_owner;
    ALTER FUNCTION billing_list_invoices(uuid, timestamptz, uuid, integer) OWNER TO athlya_owner;
    REVOKE ALL ON FUNCTION billing_invoice_status_rank(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION billing_apply_stripe_event(text, text, jsonb) FROM PUBLIC;
    REVOKE ALL ON FUNCTION billing_list_invoices(uuid, timestamptz, uuid, integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION billing_apply_stripe_event(text, text, jsonb) TO athlya_billing;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        GRANT EXECUTE ON FUNCTION billing_list_invoices(uuid, timestamptz, uuid, integer) TO athlya_app;
    END IF;
END
$$;

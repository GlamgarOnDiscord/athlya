-- =====================================================================
-- 0053: studio settings and signed webhooks (issues #759, #760)
--
-- 1. Studio settings. `studios` gains the time zone (IANA, default
--    `Europe/Paris`), a postal address and a contact email. They are
--    written under the existing `studios_admin_update_own` policy
--    (admins of the studio only) with a column-scoped grant, like the
--    branding columns of 0038. The API validates the time zone against
--    the IANA list; the checks below bound the shapes.
--
-- 2. Webhook endpoints. An admin registers HTTPS endpoints for a list of
--    event types. `secret` (the HMAC signing key) is readable by no
--    runtime role: athlya_app writes it and reads every other column;
--    only the cron claim function below returns it, to sign.
--
-- 3. Webhook deliveries. An AFTER INSERT trigger on `outbox` records one
--    delivery per enabled endpoint of the row's studio subscribed to its
--    type, in the same transaction as the domain write (the outbox is
--    already the durable record of every published event). A failure of
--    the trigger is logged and swallowed: a webhook must never block a
--    booking.
--
-- 4. The cron (`athlya_cron`) claims due deliveries with a lease
--    (`webhook_claim_deliveries`), posts them, and records each attempt
--    (`webhook_record_attempt`): a 2xx marks it delivered; anything else
--    retries after 1 min, 5 min, 30 min, 2 h and 6 h, then marks it
--    failed after the sixth attempt. Finished deliveries older than 30
--    days are purged by the claim.
--
-- Conventions (0032): functions owned by `athlya_owner`, `SET
-- search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and
-- granted to one runtime role (athlya_cron here).
--
-- Expand step: nullable columns or columns with a default, new tables,
-- a trigger that only adds rows to a new table, new functions. An old
-- Worker never reads them and runs unchanged.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Studio settings
-- ---------------------------------------------------------------------

ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Europe/Paris' NOT NULL;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "address_line" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "postal_code" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "city" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "country" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "contact_email" citext;--> statement-breakpoint

ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_settings_shape";--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_settings_shape" CHECK (
    char_length("timezone") BETWEEN 1 AND 64
    AND ("address_line" IS NULL OR char_length("address_line") BETWEEN 1 AND 200)
    AND ("postal_code" IS NULL OR char_length("postal_code") BETWEEN 1 AND 16)
    AND ("city" IS NULL OR char_length("city") BETWEEN 1 AND 100)
    AND ("country" IS NULL OR "country" ~ '^[A-Z]{2}$')
    AND ("contact_email" IS NULL OR char_length("contact_email") BETWEEN 3 AND 254)
);--> statement-breakpoint

GRANT UPDATE ("timezone", "address_line", "postal_code", "city", "country", "contact_email")
    ON "studios" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Webhook endpoints
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "url" text NOT NULL,
    "events" text[] NOT NULL,
    "secret" text NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "webhook_endpoints_url_https" CHECK ("url" ~ '^https://' AND char_length("url") <= 2048),
    CONSTRAINT "webhook_endpoints_events_known" CHECK (
        cardinality("events") BETWEEN 1 AND 16
        AND "events" <@ ARRAY[
            'reservation.created', 'reservation.waitlisted', 'reservation.cancelled',
            'reservation.promoted', 'auth.user.registered'
        ]::text[]
    ),
    CONSTRAINT "webhook_endpoints_secret_shape" CHECK ("secret" ~ '^whsec_[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "webhook_endpoints_studio_idx"
    ON "webhook_endpoints" USING btree ("studio_id");--> statement-breakpoint

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "webhook_endpoints_admin_read" ON "webhook_endpoints";--> statement-breakpoint
CREATE POLICY "webhook_endpoints_admin_read" ON "webhook_endpoints"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "webhook_endpoints_admin_insert" ON "webhook_endpoints";--> statement-breakpoint
CREATE POLICY "webhook_endpoints_admin_insert" ON "webhook_endpoints"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "webhook_endpoints_admin_update" ON "webhook_endpoints";--> statement-breakpoint
CREATE POLICY "webhook_endpoints_admin_update" ON "webhook_endpoints"
    FOR UPDATE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin')
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

DROP POLICY IF EXISTS "webhook_endpoints_admin_delete" ON "webhook_endpoints";--> statement-breakpoint
CREATE POLICY "webhook_endpoints_admin_delete" ON "webhook_endpoints"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

-- The default privileges of 0004 grant SELECT on every new table; the
-- signing secret is not part of what the application reads.
REVOKE ALL ON "webhook_endpoints" FROM athlya_app;--> statement-breakpoint
GRANT SELECT ("id", "studio_id", "url", "events", "enabled", "created_by", "created_at", "updated_at")
    ON "webhook_endpoints" TO athlya_app;--> statement-breakpoint
GRANT INSERT ("id", "studio_id", "url", "events", "secret", "enabled", "created_by", "updated_at")
    ON "webhook_endpoints" TO athlya_app;--> statement-breakpoint
GRANT UPDATE ("url", "events", "secret", "enabled", "updated_at")
    ON "webhook_endpoints" TO athlya_app;--> statement-breakpoint
GRANT DELETE ON "webhook_endpoints" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Webhook deliveries
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "event_id" text NOT NULL,
    "event_type" text NOT NULL,
    "payload" jsonb NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
    "lease_until" timestamp with time zone,
    "last_status_code" integer,
    "last_error" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "delivered_at" timestamp with time zone,
    CONSTRAINT "webhook_deliveries_status_known" CHECK ("status" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_event_unique"
    ON "webhook_deliveries" USING btree ("endpoint_id", "event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx"
    ON "webhook_deliveries" USING btree ("next_attempt_at")
    WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_recent_idx"
    ON "webhook_deliveries" USING btree ("endpoint_id", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "webhook_deliveries_admin_read" ON "webhook_deliveries";--> statement-breakpoint
CREATE POLICY "webhook_deliveries_admin_read" ON "webhook_deliveries"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');
--> statement-breakpoint

REVOKE ALL ON "webhook_deliveries" FROM athlya_app;--> statement-breakpoint
GRANT SELECT ("id", "endpoint_id", "studio_id", "event_id", "event_type", "occurred_at", "status",
              "attempts", "next_attempt_at", "last_status_code", "last_error", "created_at",
              "delivered_at")
    ON "webhook_deliveries" TO athlya_app;--> statement-breakpoint

GRANT SELECT ON "webhook_endpoints" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "webhook_deliveries" TO athlya_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enqueue_webhook_deliveries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.studio_id IS NULL THEN
        RETURN NULL;
    END IF;
    BEGIN
        INSERT INTO webhook_deliveries (endpoint_id, studio_id, event_id, event_type, payload, occurred_at)
        SELECT e.id, NEW.studio_id, NEW.event_id, NEW.event_type, NEW.payload, NEW.occurred_at
          FROM webhook_endpoints e
         WHERE e.studio_id = NEW.studio_id
           AND e.enabled
           AND NEW.event_type = ANY (e.events)
        ON CONFLICT (endpoint_id, event_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'enqueue_webhook_deliveries: % (%)', SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION public.enqueue_webhook_deliveries() OWNER TO athlya_owner;--> statement-breakpoint

DROP TRIGGER IF EXISTS "outbox_enqueue_webhooks" ON "outbox";--> statement-breakpoint
CREATE TRIGGER "outbox_enqueue_webhooks"
    AFTER INSERT ON "outbox"
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_webhook_deliveries();
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Delivery by the cron
-- ---------------------------------------------------------------------

-- Lease up to `p_limit` due deliveries of enabled endpoints (2 minutes)
-- and count the attempt. Also drops finished deliveries older than 30
-- days, a bounded batch per call.
CREATE OR REPLACE FUNCTION webhook_claim_deliveries(p_limit integer)
RETURNS TABLE (
    id uuid,
    url text,
    secret text,
    event_id text,
    event_type text,
    payload jsonb,
    occurred_at timestamptz,
    attempts integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'webhook_claim_deliveries: limit must be between 1 and 100'
            USING ERRCODE = '22023';
    END IF;

    DELETE FROM webhook_deliveries AS old
     WHERE old.id IN (
        SELECT d.id FROM webhook_deliveries d
         WHERE d.status <> 'pending' AND d.created_at < now() - interval '30 days'
         LIMIT 500
     );

    RETURN QUERY
    WITH due AS (
        SELECT d.id
          FROM webhook_deliveries d
          JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.enabled
         WHERE d.status = 'pending'
           AND d.next_attempt_at <= now()
           AND (d.lease_until IS NULL OR d.lease_until < now())
         ORDER BY d.next_attempt_at, d.id
         LIMIT p_limit
           FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE webhook_deliveries AS w
       SET lease_until = now() + interval '2 minutes',
           attempts = w.attempts + 1
      FROM due, webhook_endpoints AS e
     WHERE w.id = due.id
       AND e.id = w.endpoint_id
    RETURNING w.id, e.url, e.secret, w.event_id, w.event_type, w.payload, w.occurred_at, w.attempts;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION webhook_claim_deliveries(integer) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION webhook_claim_deliveries(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION webhook_claim_deliveries(integer) TO athlya_cron;--> statement-breakpoint

-- Record the outcome of the attempt just made on a leased delivery.
-- `p_status_code` is the HTTP status (NULL when no response came back);
-- `p_error` a short reason, never the response body. Returns the new
-- status, or NULL when the delivery is not leased (already recorded).
CREATE OR REPLACE FUNCTION webhook_record_attempt(p_id uuid, p_status_code integer, p_error text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    UPDATE webhook_deliveries AS w
       SET status = CASE
               WHEN p_status_code BETWEEN 200 AND 299 THEN 'delivered'
               WHEN w.attempts >= 6 THEN 'failed'
               ELSE 'pending'
           END,
           delivered_at = CASE WHEN p_status_code BETWEEN 200 AND 299 THEN now() END,
           next_attempt_at = now() + CASE w.attempts
               WHEN 1 THEN interval '1 minute'
               WHEN 2 THEN interval '5 minutes'
               WHEN 3 THEN interval '30 minutes'
               WHEN 4 THEN interval '2 hours'
               ELSE interval '6 hours'
           END,
           last_status_code = p_status_code,
           last_error = left(p_error, 200),
           lease_until = NULL
     WHERE w.id = p_id
       AND w.status = 'pending'
       AND w.lease_until IS NOT NULL
    RETURNING w.status INTO v_status;
    RETURN v_status;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION webhook_record_attempt(uuid, integer, text) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION webhook_record_attempt(uuid, integer, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION webhook_record_attempt(uuid, integer, text) TO athlya_cron;

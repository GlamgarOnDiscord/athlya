-- Rollback for 0036_billing_runtime.sql (issue #122).
DROP FUNCTION IF EXISTS billing_list_invoices(uuid, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS billing_apply_stripe_event(text, text, jsonb);
DROP FUNCTION IF EXISTS billing_invoice_status_rank(text);
REVOKE SELECT, INSERT ON "stripe_webhook_events" FROM athlya_owner;
DROP TABLE IF EXISTS "studio_invoices";
DROP TABLE IF EXISTS "studio_subscriptions";
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_billing') THEN
        REVOKE USAGE ON SCHEMA public FROM athlya_billing;
        DROP ROLE athlya_billing;
    END IF;
END
$$;

-- Rollback for 0053_studio_settings_webhooks.sql (issues #759, #760).
-- Webhook endpoints, their secrets and their deliveries are dropped; the
-- studio settings columns go with their values.

DROP FUNCTION IF EXISTS webhook_record_attempt(uuid, integer, text);
DROP FUNCTION IF EXISTS webhook_claim_deliveries(integer);
DROP TRIGGER IF EXISTS "outbox_enqueue_webhooks" ON "outbox";
DROP FUNCTION IF EXISTS public.enqueue_webhook_deliveries();
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhook_endpoints";

REVOKE UPDATE ("timezone", "address_line", "postal_code", "city", "country", "contact_email")
    ON "studios" FROM athlya_app;
ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_settings_shape";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "contact_email";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "country";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "city";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "postal_code";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "address_line";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "timezone";

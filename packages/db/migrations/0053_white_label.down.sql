-- Rollback for 0053_white_label.sql (issue #761).
--
-- Drops the branding function, the domains table with its trigger and
-- policy, then the three studio columns. Logos stored as R2 objects
-- stay in the bucket under `studio-logos/`; remove them by hand if the
-- rollback is final.

DROP FUNCTION IF EXISTS notification_studio_branding(uuid);

DROP TABLE IF EXISTS "studio_domains";
DROP FUNCTION IF EXISTS public.studio_domains_reset_on_hostname_change();

REVOKE UPDATE ("brand_logo_light", "brand_logo_dark", "hide_athlya_branding")
    ON "studios" FROM athlya_app;

ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_brand_logo_dark_check";
ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_brand_logo_light_check";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "hide_athlya_branding";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "brand_logo_dark";
ALTER TABLE "studios" DROP COLUMN IF EXISTS "brand_logo_light";

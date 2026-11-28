-- =====================================================================
-- 0053: white label, studio logos, custom domains and branded e-mails
-- (issue #761, v1.4 roadmap "Marque blanche")
--
-- 1. Studio logos and the Athlya mention. `brand_logo_light` and
--    `brand_logo_dark` hold either an https URL (R2 public object) or a
--    capped `data:image/*;base64,` URL when no bucket is configured,
--    the same two storage modes as member avatars. The CHECK refuses
--    any other scheme and anything larger than a 128 KiB image encoded
--    in base64. `hide_athlya_branding` drops the "via Athlya" footer of
--    the studio's transactional e-mails. `athlya_app` may update these
--    three columns only (the 0038 column grant pattern), under the
--    existing `studios_admin_update_own` policy.
--
-- 2. Custom domains. `studio_domains` keeps at most one web domain and
--    one e-mail sending domain per studio. The API writes the hostname,
--    a random ownership token and the result of each DNS check; only an
--    operator sets `activated_at` (Cloudflare custom hostname or Resend
--    domain provisioned) and `dkim_record` (the DKIM TXT value Resend
--    issues), so `athlya_app` gets no UPDATE grant on either. A hostname
--    can be claimed by several studios while pending, but only one row
--    per (kind, hostname) can be verified, and only the studio that can
--    publish its own token in the DNS gets there. Changing the hostname
--    resets the verification and the activation (trigger). FORCE RLS,
--    one policy: an admin of the studio, for every command.
--
-- 3. `notification_studio_branding(uuid)` gives the notifications
--    consumer, which runs without tenant claims, the branding of the
--    recipient's studio and its sending domain once verified and
--    activated. Nothing else leaves the function.
--
-- Conventions (0032): functions owned by `athlya_owner` (BYPASSRLS),
-- `SET search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and
-- granted to `athlya_app` only. The trigger function pins its
-- search_path too.
--
-- Expand step: two nullable columns, one column with a default, a new
-- table and new functions. An old Worker never reads or writes any of
-- them and runs unchanged against this schema.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Studio logos and the Athlya mention
-- ---------------------------------------------------------------------

ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "brand_logo_light" text;--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN IF NOT EXISTS "brand_logo_dark" text;--> statement-breakpoint
ALTER TABLE "studios"
    ADD COLUMN IF NOT EXISTS "hide_athlya_branding" boolean NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_brand_logo_light_check";--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_brand_logo_light_check" CHECK (
    "brand_logo_light" IS NULL
    OR (
        length("brand_logo_light") <= 180000
        AND (
            "brand_logo_light" ~ '^https://[^\s"''<>]+$'
            OR "brand_logo_light" ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
        )
    )
);--> statement-breakpoint

ALTER TABLE "studios" DROP CONSTRAINT IF EXISTS "studios_brand_logo_dark_check";--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_brand_logo_dark_check" CHECK (
    "brand_logo_dark" IS NULL
    OR (
        length("brand_logo_dark") <= 180000
        AND (
            "brand_logo_dark" ~ '^https://[^\s"''<>]+$'
            OR "brand_logo_dark" ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
        )
    )
);--> statement-breakpoint

GRANT UPDATE ("brand_logo_light", "brand_logo_dark", "hide_athlya_branding")
    ON "studios" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Custom web domain and e-mail sending domain
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "studio_domains" (
    "id" uuid PRIMARY KEY DEFAULT gen_uuid_v7() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "kind" text NOT NULL,
    "hostname" text NOT NULL,
    "verification_token" text NOT NULL,
    "status" text DEFAULT 'pending' NOT NULL,
    "dns_checks" jsonb,
    "dkim_record" text,
    "last_checked_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "activated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "studio_domains_kind_check" CHECK ("kind" IN ('web', 'email')),
    CONSTRAINT "studio_domains_status_check" CHECK ("status" IN ('pending', 'verified', 'failed')),
    CONSTRAINT "studio_domains_hostname_check" CHECK (
        length("hostname") <= 253
        AND "hostname" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
    ),
    CONSTRAINT "studio_domains_token_check" CHECK ("verification_token" ~ '^[a-f0-9]{32}$'),
    CONSTRAINT "studio_domains_dns_checks_check" CHECK (
        "dns_checks" IS NULL OR jsonb_typeof("dns_checks") = 'array'
    ),
    CONSTRAINT "studio_domains_dkim_record_check" CHECK (
        "dkim_record" IS NULL OR length("dkim_record") <= 2048
    )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "studio_domains_studio_kind_unique"
    ON "studio_domains" ("studio_id", "kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "studio_domains_verified_hostname_unique"
    ON "studio_domains" ("kind", "hostname") WHERE "status" = 'verified';--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.studio_domains_reset_on_hostname_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.hostname IS DISTINCT FROM OLD.hostname THEN
        NEW.status := 'pending';
        NEW.dns_checks := NULL;
        NEW.dkim_record := NULL;
        NEW.last_checked_at := NULL;
        NEW.verified_at := NULL;
        NEW.activated_at := NULL;
    END IF;
    RETURN NEW;
END
$$;--> statement-breakpoint

ALTER FUNCTION public.studio_domains_reset_on_hostname_change() OWNER TO athlya_owner;--> statement-breakpoint

DROP TRIGGER IF EXISTS "studio_domains_reset_on_hostname_change" ON "studio_domains";--> statement-breakpoint
CREATE TRIGGER "studio_domains_reset_on_hostname_change"
    BEFORE UPDATE ON "studio_domains"
    FOR EACH ROW EXECUTE FUNCTION public.studio_domains_reset_on_hostname_change();--> statement-breakpoint

ALTER TABLE "studio_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "studio_domains_admin_own" ON "studio_domains";--> statement-breakpoint
CREATE POLICY "studio_domains_admin_own" ON "studio_domains"
    FOR ALL
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin')
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');--> statement-breakpoint

GRANT SELECT, INSERT, DELETE ON "studio_domains" TO athlya_app;--> statement-breakpoint
GRANT UPDATE ("hostname", "verification_token", "status", "dns_checks", "last_checked_at", "verified_at")
    ON "studio_domains" TO athlya_app;--> statement-breakpoint
GRANT SELECT ON "studio_domains" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Branding of a notification recipient's studio
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notification_studio_branding(p_user_id uuid)
RETURNS TABLE (
    studio_name text,
    brand_color text,
    brand_logo_light text,
    hide_athlya_branding boolean,
    email_domain text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.name,
           s.brand_color,
           s.brand_logo_light,
           s.hide_athlya_branding,
           (SELECT d.hostname
              FROM studio_domains d
             WHERE d.studio_id = s.id
               AND d.kind = 'email'
               AND d.status = 'verified'
               AND d.activated_at IS NOT NULL)
      FROM users u
      JOIN studios s ON s.id = u.studio_id
     WHERE u.id = p_user_id
       AND u.deleted_at IS NULL
       AND s.deleted_at IS NULL
$$;--> statement-breakpoint

ALTER FUNCTION notification_studio_branding(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION notification_studio_branding(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notification_studio_branding(uuid) TO athlya_app;

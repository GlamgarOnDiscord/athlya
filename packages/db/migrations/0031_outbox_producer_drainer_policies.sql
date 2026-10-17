-- =====================================================================
-- Athlya Platform — outbox producer and drainer privileges (0031)
--
-- Issue #497. The outbox contradicted the NOBYPASSRLS runtime posture:
--
--   * Producers (`athlya_app`, the Worker's DB_URL role) had table-level
--     INSERT but no FOR INSERT policy, so every event insert raised
--     42501 and could roll back the booking/cancel mutation it belongs
--     to (tests/rls/outbox.sql asserted the denial).
--   * The drainer (`athlya_cron`, CRON_DB_URL) could SELECT and DELETE
--     but not UPDATE, so it could neither claim rows (SELECT … FOR
--     UPDATE SKIP LOCKED + attempts++) nor stamp published_at.
--
-- Privilege boundaries after this migration:
--
--   Producer — a session may INSERT an outbox row only for the studio of
--   its tenant context (`app.studio_id`, set by withTenant) and only as
--   an undelivered event (published_at NULL, attempts 0). No tenant
--   context → no insert. SELECT stays admin-of-own-studio only; there is
--   still no UPDATE/DELETE policy for tenants, so a producer can never
--   read, drain or rewrite another studio's events.
--
--   Drainer — `athlya_cron` gets column-scoped UPDATE (published_at,
--   attempts) plus a matching policy, on top of the SELECT/DELETE it
--   already had (0019). It still cannot INSERT or change payloads.
--
-- Expand-only (canary-safe): adds a policy and a grant; nothing the
-- previous Worker version relies on is removed.
-- =====================================================================

DROP POLICY IF EXISTS "outbox_insert_tenant" ON "outbox";--> statement-breakpoint
CREATE POLICY "outbox_insert_tenant" ON "outbox"
    FOR INSERT
    WITH CHECK (
        "studio_id" IS NOT NULL
        AND "studio_id" = public.app_studio_id()
        AND "published_at" IS NULL
        AND "attempts" = 0
    );
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
    GRANT UPDATE ("published_at", "attempts") ON "outbox" TO athlya_cron;
  END IF;
END
$$;
--> statement-breakpoint

DROP POLICY IF EXISTS "outbox_cron_update" ON "outbox";--> statement-breakpoint
CREATE POLICY "outbox_cron_update" ON "outbox"
    FOR UPDATE
    USING (current_user = 'athlya_cron')
    WITH CHECK (current_user = 'athlya_cron');

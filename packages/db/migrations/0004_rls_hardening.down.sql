-- =====================================================================
-- Rollback for 0004_rls_hardening.sql
--
-- Reverses (in reverse dependency order):
--
--   1. Drops the `ALTER DEFAULT PRIVILEGES` rule installed by 0004 so
--      future tables don't auto-grant SELECT to athlya_app.
--   2. Revokes every DML grant added by 0004. The `audit_log`
--      SELECT/INSERT grants from 0003 are NOT revoked here — that is
--      owned by `0003_audit_anonymization.down.sql`. We deliberately
--      revoke ALL on audit_log first then re-grant SELECT,INSERT to
--      restore the 0003 baseline state.
--   3. Demotes `athlya_app` from LOGIN back to NOLOGIN, matching the
--      state 0003 left it in. We do NOT drop the role itself —
--      `0003_audit_anonymization.down.sql` is responsible for that.
--
-- We deliberately do NOT `NO FORCE ROW LEVEL SECURITY` here:
-- migrations 0001 / 0002 owned the original FORCE statements; the
-- 0004 forward migration restated them for self-containment. Rolling
-- them back is the responsibility of `0001_rls.down.sql` and
-- `0002_export_jobs.down.sql`.
--
-- Idempotent: REVOKE on a non-existent privilege is a no-op,
-- `ALTER ROLE` on absent attributes is a no-op, and `ALTER DEFAULT
-- PRIVILEGES … REVOKE` is also a no-op when the rule is absent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the default-privileges rule for future tables
-- ---------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE SELECT ON TABLES FROM athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Revoke DML grants
-- ---------------------------------------------------------------------

REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM athlya_app;--> statement-breakpoint

REVOKE SELECT, INSERT, UPDATE, DELETE ON "users"            FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "classes"          FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "reservations"     FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "workout_sessions" FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "outbox"           FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "idempotency_keys" FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "push_tokens"      FROM athlya_app;--> statement-breakpoint
REVOKE SELECT, INSERT, UPDATE, DELETE ON "export_jobs"      FROM athlya_app;--> statement-breakpoint

REVOKE SELECT ON "studios" FROM athlya_app;--> statement-breakpoint

-- audit_log: revoke everything 0004 (re-)granted, then restore the
-- 0003 baseline of SELECT,INSERT. `0003_audit_anonymization.down.sql`
-- owns the final REVOKE when 0003 itself rolls back.
REVOKE ALL ON "audit_log" FROM athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Demote athlya_app back to the 0003 state
--
--    Production cutover sets a password via `ALTER ROLE … PASSWORD`
--    out of band. Rolling back must clear that password as well so
--    the role cannot be used to log in even if the DBA forgot to
--    rotate the credential. `PASSWORD NULL` is the canonical "no
--    password" form.
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        ALTER ROLE athlya_app
            NOLOGIN
            NOSUPERUSER
            NOBYPASSRLS
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            PASSWORD NULL;
    END IF;
END
$$;

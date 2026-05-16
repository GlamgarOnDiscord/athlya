-- =====================================================================
-- Rollback for 0003_audit_anonymization.sql
--
-- Reverses every change made by the forward migration, in reverse
-- dependency order:
--
--   1. Drop the SECURITY DEFINER function (releases the only mutation
--      path into audit_log).
--   2. Restore the audit_log_immutable() trigger body to its 0000
--      form, removing the `athlya_owner` bypass.
--   3. Give audit_log ownership back to the database migration role
--      (`CURRENT_USER` at the time this script is executed — typically
--      the superuser that applied 0000_init.sql originally). Using
--      CURRENT_USER keeps the rollback portable across Neon / CI /
--      local Postgres where the migration runner identity differs.
--   4. Reassign any objects owned by athlya_owner / athlya_cron /
--      athlya_app (there should be none after step 3; belt-and-braces
--      `REASSIGN OWNED ... TO CURRENT_USER` handles any residue
--      introduced by downstream migrations that chose to create
--      objects owned by these roles).
--   5. Revoke grants that reference the dropped roles (must happen
--      before DROP ROLE, which refuses to drop a role that still owns
--      privileges anywhere).
--   6. Drop the three roles.
--
-- Re-run safe: every statement is idempotent (`DROP IF EXISTS`, guarded
-- `DO $$` blocks).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Drop the SECURITY DEFINER function
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS anonymize_user_audit(uuid);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Restore the original immutability trigger body (no bypass)
--
-- Matches the definition in 0000_init.sql.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Transfer audit_log ownership back to the current migration role.
--
-- `DO` block so we can reference `CURRENT_USER` as an identifier rather
-- than a string literal (`ALTER TABLE ... OWNER TO <ident>` does not
-- accept a string).
-- ---------------------------------------------------------------------

DO $$
DECLARE
    caller name := CURRENT_USER;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_owner') THEN
        EXECUTE format('ALTER TABLE "audit_log" OWNER TO %I', caller);
    END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Reassign any residual ownership back to the caller
-- ---------------------------------------------------------------------

DO $$
DECLARE
    caller name := CURRENT_USER;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_owner') THEN
        EXECUTE format('REASSIGN OWNED BY athlya_owner TO %I', caller);
        EXECUTE 'DROP OWNED BY athlya_owner';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
        EXECUTE format('REASSIGN OWNED BY athlya_cron TO %I', caller);
        EXECUTE 'DROP OWNED BY athlya_cron';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        EXECUTE format('REASSIGN OWNED BY athlya_app TO %I', caller);
        EXECUTE 'DROP OWNED BY athlya_app';
    END IF;
END
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Drop the roles
-- ---------------------------------------------------------------------

DROP ROLE IF EXISTS athlya_owner;--> statement-breakpoint
DROP ROLE IF EXISTS athlya_cron;--> statement-breakpoint
DROP ROLE IF EXISTS athlya_app;

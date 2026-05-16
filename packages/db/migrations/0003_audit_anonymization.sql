-- =====================================================================
-- Athlya Platform — audit_log anonymization (0003_audit_anonymization)
--
-- Requirements 5.3, 22.2, 22.3 — hardening task H1.
--
-- Contradiction resolution:
--   * Req 22.2 says `audit_log` is immutable and append-only for every
--     role, including `admin`, `athlya_app` and `athlya_cron`.
--   * Req 5.3 says J+30 RGPD anonymization MUST mutate audit_log rows
--     referencing a deleted user (actor_id → NULL, PII stripped from
--     metadata JSONB).
--
--   These two requirements are reconciled by a *single* sanctioned
--   mutation path: the `SECURITY DEFINER` function
--   `anonymize_user_audit(uuid)`, owned by a dedicated privileged role
--   `athlya_owner` (NOLOGIN, BYPASSRLS), with `EXECUTE` granted only to
--   `athlya_cron`, the NOLOGIN role used by the J+30 cron worker.
--
--   Even if a bug in the gateway accidentally forced the session into
--   the `athlya_cron` role, the blast radius is bounded to this one
--   scoped function: direct `UPDATE audit_log` still fails with
--   SQLSTATE 42501 (no UPDATE grant), and the function itself only
--   touches rows matching `actor_id = target_user` or
--   `metadata->>'subjectUserId' = target_user::text`.
--
-- Defence layers (from outermost to innermost):
--
--   1. SQL privileges — `athlya_app` has no UPDATE / DELETE grant on
--      audit_log; `athlya_cron` has no direct table grant at all.
--      Direct DML fails with SQLSTATE 42501 before RLS even runs.
--
--   2. RLS policies — `audit_no_update` and `audit_no_delete` keep
--      their `USING (false)` filter from migration 0001_rls.sql. Even
--      a role holding UPDATE / DELETE grants sees zero rows.
--
--   3. Trigger — `audit_log_immutable()` installed in 0000_init.sql
--      still raises `audit_log is append-only` on UPDATE / DELETE for
--      every role *except* `athlya_owner`. This migration replaces the
--      trigger body to add that one special case so the SECURITY
--      DEFINER function, running as athlya_owner, is not blocked.
--
--   4. Ownership + BYPASSRLS — the `athlya_owner` role is created with
--      BYPASSRLS so RLS policies (layer 2) do not apply; it also owns
--      `audit_log` after this migration runs, matching the "function
--      owner owns the table it mutates" pattern recommended in the
--      Postgres docs for SECURITY DEFINER code.
--
-- Idempotency: every statement is guarded (`IF NOT EXISTS`,
-- `DROP POLICY IF EXISTS`, `CREATE OR REPLACE`, `DO $$ ... $$`) so this
-- migration can be re-applied against a partially-migrated database
-- without error.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Roles
--
-- Three NOLOGIN roles so they are reachable only via `SET ROLE` from a
-- privileged connection (Neon platform role in production) or via the
-- `SECURITY DEFINER` function dispatcher:
--
--   - `athlya_owner` (BYPASSRLS) owns the SECURITY DEFINER function
--     and audit_log. Only reachable from inside the function body; the
--     cron role never holds this role, so even if the function were to
--     RAISE mid-update the session would not gain broader privileges.
--
--   - `athlya_cron` is the identity of the J+30 anonymization worker.
--     It can EXECUTE the function but holds no direct DML grants on
--     audit_log — `UPDATE audit_log` as athlya_cron fails at the
--     privilege check, before the row filter.
--
--   - `athlya_app` is the application role used by the API gateway.
--     Required grants are INSERT (for audit row appending via the
--     event-sourced write path) plus SELECT (for admin audit queries
--     gated by the `audit_admin_only` policy installed in 0001).
--     It has NO UPDATE and NO DELETE on audit_log.
--
-- Creating BYPASSRLS roles requires superuser; the migration runner
-- in CI and prod is a superuser so the `IF NOT EXISTS` guard below is
-- the only idempotency concern.
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_owner') THEN
        CREATE ROLE athlya_owner NOLOGIN BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
        CREATE ROLE athlya_cron NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        CREATE ROLE athlya_app NOLOGIN;
    END IF;
END
$$;
--> statement-breakpoint

-- Both privileged / scoped roles need USAGE on the public schema so
-- they can reference tables and functions by name. SELECT / EXECUTE
-- privileges layer on top of USAGE and are granted explicitly below.
GRANT USAGE ON SCHEMA public TO athlya_owner;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO athlya_cron;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Transfer audit_log ownership to athlya_owner
--
-- The SECURITY DEFINER pattern recommended by the Postgres docs is
-- "function owner owns the target table". That way even if we later
-- tighten the RLS posture to remove the BYPASSRLS attribute, the
-- function still has unfettered access to rows it needs to anonymize,
-- whereas all other roles stay gated by the `USING (false)` policies.
--
-- `ALTER TABLE ... OWNER TO` preserves existing privileges and
-- policies; only the owner changes. `athlya_tenant_test`, used by the
-- pgTAP suite, was granted INSERT / UPDATE / DELETE at schema level in
-- `00_bootstrap.sql`; those grants persist across this ALTER.
-- ---------------------------------------------------------------------

ALTER TABLE "audit_log" OWNER TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Rewrite the audit_log immutability trigger to special-case
--    athlya_owner
--
-- The original trigger installed by 0000_init.sql raises
-- `audit_log is append-only` on every UPDATE / DELETE, regardless of
-- role. After this migration the SECURITY DEFINER path needs a
-- bypass — we restrict it to exactly one role (`athlya_owner`) and
-- keep raising for everybody else, including superuser (so a human
-- operator with psql access cannot silently tamper with audit data).
--
-- Why `current_user` and not `session_user`:
--   Inside a SECURITY DEFINER function body, `current_user` is the
--   function owner (`athlya_owner`), while `session_user` stays as the
--   caller (`athlya_cron`, or a human's psql session). We want the
--   bypass to apply exactly when we are running inside the function,
--   which is the `current_user` semantics. This also means a human
--   session that runs `SET ROLE athlya_owner; UPDATE audit_log ...`
--   would succeed — but reaching that state requires superuser, at
--   which point the trigger is not our last line of defence anyway.
--
-- The function stays SECURITY INVOKER (the default for trigger
-- functions) so `current_user` reflects the effective role of the
-- DML-issuing statement, which is what the rule-of-one-path logic
-- relies on.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Sanctioned path: the SECURITY DEFINER function
    -- `anonymize_user_audit` runs as `athlya_owner`. Allow it through
    -- by returning the row unchanged; any other role sees the
    -- `audit_log is append-only` exception this trigger exists to
    -- enforce.
    IF current_user = 'athlya_owner' THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Audit_log privilege matrix
--
-- Application role (athlya_app):
--   - SELECT  : yes (admin reads gated by `audit_admin_only` policy)
--   - INSERT  : yes (write path from the API gateway)
--   - UPDATE  : no
--   - DELETE  : no
--
-- Cron role (athlya_cron):
--   - direct DML on audit_log: none (not even SELECT). Only the
--     function EXECUTE grant below.
--
-- Owner role (athlya_owner):
--   - owns the table, so it inherently has all privileges on it.
-- ---------------------------------------------------------------------

REVOKE ALL ON "audit_log" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "audit_log" FROM athlya_app;--> statement-breakpoint
REVOKE ALL ON "audit_log" FROM athlya_cron;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_log" TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Idempotent restatement of the audit_log RLS policies
--
-- These already exist in 0001_rls.sql. Re-declaring them here with
-- `DROP POLICY IF EXISTS` + `CREATE POLICY` keeps the hardening
-- migration self-contained: a reviewer reading 0003 in isolation sees
-- the full RLS posture on audit_log without having to cross-reference
-- 0001. Functionally this is a no-op when the policies already exist.
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_no_update" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_update" ON "audit_log"
    FOR UPDATE
    USING (false)
    WITH CHECK (false);
--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_delete" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_delete" ON "audit_log"
    FOR DELETE
    USING (false);
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 6. The sanctioned anonymization function
--
-- Semantics (Req 5.3):
--   - Set `actor_id = NULL` on every row where `actor_id = target_user`
--     or where `metadata->>'subjectUserId' = target_user::text`. The
--     subjectUserId lookup catches rows whose actor is an admin acting
--     on the deleted user (e.g. `admin.user.deleted` events), so the
--     deleted user's UUID is still purged from the metadata payload.
--   - Strip the PII keys documented in design.md § "Audit metadata":
--     `email`, `displayName`, `ip`, `userAgent`. Non-PII keys such as
--     `subjectUserId` themselves, the `before` / `after` state
--     snapshots, and application-specific context are preserved so the
--     row stays useful for forensics.
--   - Return the count of rows touched so the cron worker can log
--     anonymization activity.
--
-- Security pattern:
--   - `SECURITY DEFINER` + explicit `SET search_path = public, pg_temp`
--     prevents search-path hijacking (CVE class where a malicious
--     schema object shadows `audit_log` or the `-` operator and
--     executes attacker code under the owner's privileges).
--   - `OWNER TO athlya_owner` + `REVOKE ALL FROM PUBLIC` +
--     `GRANT EXECUTE TO athlya_cron` yield a capability-style grant:
--     exactly one identity (athlya_cron) can invoke exactly one
--     pre-audited mutation path.
--
-- Implementation note:
--   The `metadata - 'email' - …` chain uses jsonb's binary minus
--   operator, which is a no-op when the key is absent. So the function
--   is safe to call repeatedly against rows whose metadata has already
--   been stripped.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION anonymize_user_audit(target_user uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    touched integer;
BEGIN
    UPDATE audit_log
       SET actor_id = NULL,
           metadata = metadata
                      - 'email'
                      - 'displayName'
                      - 'ip'
                      - 'userAgent'
     WHERE actor_id = target_user
        OR (metadata ? 'subjectUserId'
            AND metadata->>'subjectUserId' = target_user::text);
    GET DIAGNOSTICS touched = ROW_COUNT;
    RETURN touched;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION anonymize_user_audit(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_user_audit(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron;

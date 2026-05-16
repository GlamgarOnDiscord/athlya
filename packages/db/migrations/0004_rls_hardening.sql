-- =====================================================================
-- Athlya Platform — RLS hardening + dedicated app role (0004_rls_hardening)
--
-- Tasks B2.1 / B2.2 — Requirements 13.6, H1.
--
-- Why this migration exists
-- --------------------------
-- Migration `0001_rls.sql` enabled RLS + FORCE ROW LEVEL SECURITY on
-- every tenant-scoped table and installed a complete policy catalogue.
-- BUT in production the API gateway connects with `neondb_owner` —
-- the database owner role on Neon — which is **BYPASSRLS by default**.
-- Consequence: every policy is silently ignored at runtime, and RLS
-- effectively becomes a documentation-only feature.
--
-- Migration `0003_audit_anonymization.sql` already created an
-- `athlya_app` role as NOLOGIN (used only as the audience of the
-- `audit_log` SELECT/INSERT grants). This migration:
--
--   1. Confirms `athlya_app` exists (idempotent re-create) and ELEVATES
--      it from NOLOGIN to a real LOGIN role with the explicit
--      attributes `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
--      NOREPLICATION`. This is the production runtime identity.
--   2. Grants the application DML privileges on every tenant-scoped
--      table (users, classes, reservations, workout_sessions, outbox,
--      idempotency_keys, push_tokens, export_jobs). `studios` stays
--      READ-ONLY because studio creation/edit is platform-admin only
--      and runs under a different role (Epic B9).
--   3. Re-applies `ALTER TABLE … FORCE ROW LEVEL SECURITY` on every
--      tenant-scoped table for idempotence. A no-op when already
--      FORCEd by 0001, but defensive against a partially-applied
--      schema state where 0001 was rolled back without the
--      corresponding role removal.
--
-- Password handling — OUT OF BAND
-- --------------------------------
-- This migration does NOT set a password for `athlya_app`. The role
-- password MUST be provisioned by the operator BEFORE swapping the
-- runtime `DB_URL` over:
--
--     -- Run as superuser (neondb_owner) via Neon Console SQL editor:
--     ALTER ROLE athlya_app PASSWORD 'STRONG_RANDOM_64_CHARS';
--
-- The runbook in `docs/runbooks/db-role-switch.md` documents the full
-- cutover procedure (Neon Console → Cloudflare Workers secret →
-- restart). Until the cutover, `DB_URL` keeps pointing to the
-- BYPASSRLS owner role and this migration is fully non-disruptive
-- (FORCE has no effect on a BYPASSRLS connection).
--
-- Rollback
-- --------
-- `0004_rls_hardening.down.sql` revokes every grant added here and
-- demotes the role back to `NOLOGIN`. It deliberately does NOT
-- `NO FORCE` the tables — FORCE was added by 0001 and rolling it
-- back is the responsibility of `0001_rls.down.sql`.
--
-- Idempotency
-- -----------
-- Every statement is guarded so the migration is safe to re-apply:
--   - `DO $$ … $$` for role creation + attribute changes.
--   - `IF NOT EXISTS` patterns inline where supported.
--   - `GRANT` / `REVOKE` are inherently idempotent (re-granting an
--     existing privilege is a no-op).
--   - `ALTER TABLE … FORCE ROW LEVEL SECURITY` is a no-op when the
--     state is already FORCEd.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Ensure the role exists (idempotent re-create) and elevate it
--    from NOLOGIN (0003) to a production LOGIN role.
--
--    The attribute set is intentionally restrictive:
--      - LOGIN          → can authenticate (was NOLOGIN in 0003).
--      - NOSUPERUSER    → cannot bypass any check.
--      - NOBYPASSRLS    → policies on FORCEd tables WILL apply.
--      - NOCREATEDB     → cannot provision new databases.
--      - NOCREATEROLE   → cannot create / alter / drop roles.
--      - NOREPLICATION  → cannot stream WAL.
--
--    `ALTER ROLE` is the right verb here — `CREATE ROLE` would fail
--    on the second run because attributes cannot be re-declared.
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_app') THEN
        -- Defensive branch: 0003 should have created this role. If
        -- 0003 was rolled back or skipped, recreate it here so 0004
        -- can be applied standalone against a fresh DB.
        CREATE ROLE athlya_app NOLOGIN;
    END IF;
    -- Elevate to production runtime attributes. Repeated application
    -- is a no-op when the attributes already match.
    ALTER ROLE athlya_app
        LOGIN
        NOSUPERUSER
        NOBYPASSRLS
        NOCREATEDB
        NOCREATEROLE
        NOREPLICATION;
END
$$;
--> statement-breakpoint

-- USAGE on the schema is required before any object-level grant can
-- be exercised; 0003 already granted this but re-granting is a no-op.
GRANT USAGE ON SCHEMA public TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Application DML grants on tenant-scoped tables.
--
--    `audit_log` was already granted SELECT, INSERT in 0003; we re-grant
--    here for self-containment (idempotent). UPDATE / DELETE on
--    `audit_log` remain forbidden — the immutability trigger plus the
--    `audit_no_update` / `audit_no_delete` policies are the contract.
--
--    `studios` is READ-ONLY for the application: studio
--    provisioning runs under a platform-admin role (Epic B9). When
--    `/v1/studios/me` ships, write grants will be added in a later
--    migration.
--
--    Read-only tables (covered by SELECT only):
--      - studios
--    DML tables (SELECT/INSERT/UPDATE/DELETE):
--      - users, classes, reservations, workout_sessions,
--        outbox, idempotency_keys, push_tokens, export_jobs
--    Append-only with read:
--      - audit_log (SELECT, INSERT only — UPDATE/DELETE are forbidden
--        by the trigger + policies regardless of grants)
-- ---------------------------------------------------------------------

GRANT SELECT ON "studios" TO athlya_app;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "users"            TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "classes"          TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "reservations"     TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workout_sessions" TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox"           TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_keys" TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_tokens"      TO athlya_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "export_jobs"      TO athlya_app;--> statement-breakpoint

-- audit_log is special: SELECT + INSERT only (re-grant idempotent
-- with 0003's grant block). UPDATE/DELETE remain forbidden by the
-- `audit_no_update` / `audit_no_delete` policies (FORCEd) and by the
-- `audit_log_immutable` trigger.
--
-- KNOWN TENSION (tracked, NOT fixed by this migration): 0001's
-- `audit_no_insert` policy is `WITH CHECK (false)`, which on a
-- FORCEd table blocks INSERTs from `athlya_app` regardless of this
-- GRANT. The original design (0001 § 8) assumed audit writes would
-- go through a BYPASSRLS service role. The current API gateway
-- writes audits as `athlya_app` from `members-audit-writer-drizzle.ts`
-- and other adapters, so once the production `DB_URL` is cut over
-- to `athlya_app` (per `docs/runbooks/db-role-switch.md`), audit
-- INSERTs WILL fail until the policy is relaxed. A follow-up
-- migration in slice B2-bis will replace `audit_no_insert
-- WITH CHECK (false)` with `WITH CHECK (true)` (or drop the policy
-- entirely) so the GRANT becomes effective. The cutover runbook
-- documents the order: relax policy first, then switch DB_URL.
GRANT SELECT, INSERT ON "audit_log" TO athlya_app;--> statement-breakpoint

-- Sequences that the application's INSERTs implicitly bump (BIGSERIAL
-- on `audit_log.id`, etc.). Without USAGE on the sequence, an INSERT
-- by athlya_app fails with "permission denied for sequence". The
-- ALL SEQUENCES grant covers current and future BIGSERIAL columns
-- without listing them one by one.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO athlya_app;--> statement-breakpoint

-- Make any future tables created in `public` automatically inherit a
-- SELECT-only baseline for athlya_app. Per-table DML grants must
-- still be added explicitly in subsequent migrations — this default
-- guards against accidentally leaving a new table inaccessible to the
-- application during the window between table creation and the next
-- grant migration. (Not used for sequences because the grant above
-- already covers all current ones; ALTER DEFAULT PRIVILEGES on
-- sequences would only affect future ones, which we re-grant per
-- migration anyway.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. FORCE ROW LEVEL SECURITY on every tenant-scoped table.
--
--    Already FORCEd by 0001_rls.sql; restated here for self-contained
--    readability (a reviewer reading 0004 in isolation sees that
--    cross-tenant rows are protected) AND for defensive idempotence
--    if 0001 was partially rolled back. Re-applying FORCE is a no-op
--    when the table is already in FORCEd state.
--
--    We do NOT touch ENABLE / DISABLE here — that is owned by 0001.
--
--    Special case — `export_jobs`: 0002 already enabled + FORCEd it
--    independently of 0001, so the restate here is also a no-op.
--
--    Special case — `outbox`: 0001 FORCEd it. The drain worker runs
--    under a BYPASSRLS service role (not `athlya_app`), so the FORCE
--    does not block legitimate drainage.
-- ---------------------------------------------------------------------

ALTER TABLE "users"            FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "classes"          FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reservations"     FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workout_sessions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log"        FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox"           FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_tokens"      FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studios"          FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_jobs"      FORCE ROW LEVEL SECURITY;

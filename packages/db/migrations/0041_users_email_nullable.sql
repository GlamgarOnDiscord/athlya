-- =====================================================================
-- Athlya Platform — users.email becomes nullable (0041)
--
-- Issue #628. The RGPD retention cron (`anonymizeExpiredUsers`,
-- `packages/api/src/maintenance/rgpd-purge.ts`) anonymises soft-deleted
-- users past the retention window with `SET email = NULL`, but
-- `users.email` was still `NOT NULL` from `0000_init.sql`. Every purge
-- tick failed with SQLSTATE 23502, so expired accounts were never
-- anonymised.
--
-- An anonymised row keeps its id (FKs from reservations, workout
-- sessions and the audit log stay valid) and its `deleted_at`
-- tombstone, with `email` NULL. `users_email_live_check` keeps the
-- NULL confined to those tombstones: a live user (`deleted_at IS NULL`)
-- must hold an email, so a NULL passed to a member-creation function
-- fails with 23514 instead of creating an account nobody can log into.
--
-- Readers that can see an anonymised row:
--   - `auth_find_active_user_by_email` and `notification_recipient`
--     filter `deleted_at IS NULL`, and `email = $1` never matches NULL;
--   - `users_email_active_unique` (0026) is partial on
--     `deleted_at IS NULL` and ignores NULLs anyway;
--   - `auth_find_user_by_id` and `export_job_profile` do return it,
--     with a NULL email; the new API adapters narrow it and treat the
--     account as gone.
-- No SECURITY DEFINER function changes, so owners, search_path and
-- EXECUTE grants are untouched.
--
-- Canary: relaxing NOT NULL breaks no INSERT or UPDATE of an old
-- Worker. Once 0041 is applied, the old Worker's RGPD cron (same
-- statement) starts writing NULL emails, which is the fix. Old readers
-- can then meet a NULL email only through `auth_find_user_by_id` on a
-- soft-deleted row, and every such path already rejects a soft-deleted
-- user before using the email (refresh, billing checkout); account
-- deletion replays its idempotent cascade. Apply before, or together
-- with, the deploy.
--
-- The CHECK is added in one step, like 0024: every existing row has an
-- email (the column was NOT NULL until this statement), so validation
-- cannot fail, and NOT VALID + VALIDATE would not shorten the lock
-- inside the migration's single transaction.
-- =====================================================================

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users"
    ADD CONSTRAINT "users_email_live_check"
    CHECK ("email" IS NOT NULL OR "deleted_at" IS NOT NULL);

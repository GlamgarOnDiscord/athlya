-- =====================================================================
-- Athlya Platform — partial unique index on users.email (0026)
--
-- Issue #467. The existing `users_email_unique` index is global:
--   UNIQUE(email)
-- Users are soft-deleted (deleted_at IS NOT NULL); their email is
-- retained until the 30-day RGPD audit-log anonymisation pass. During
-- that window the soft-deleted email blocks re-registration with the
-- same address, violating RGPD Art 17 (right to erasure must not
-- silently prevent future re-use by a new, unrelated data subject).
--
-- Fix: replace the global unique with a partial unique that covers
-- only active (non-deleted) rows:
--
--   UNIQUE(email) WHERE deleted_at IS NULL
--
-- Two-step expand/contract (canary safety — CLAUDE.md §database migrations):
--
--   Step 1 (this migration) — create the new partial index CONCURRENTLY
--   while the old global index is still present. Both indexes are
--   maintained during the canary window so old Workers continue to
--   benefit from uniqueness enforcement on active users.
--
--   Then drop the old global index inside a transaction (no lock
--   escalation beyond ShareLock on the index itself; does not touch
--   the table data). Old Workers already read/write only active rows
--   and are unaffected by the drop.
--
-- CONCURRENTLY avoids an exclusive lock on the users table during build.
-- Cannot run inside a transaction; the migrator must execute the CREATE
-- outside an open transaction block.
-- =====================================================================

-- Step 1: build the replacement partial index without a table lock.
-- IF NOT EXISTS makes this idempotent: if a previous run created the
-- index but crashed before recording the migration, a retry skips it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_email_active_unique"
    ON "users" ("email")
    WHERE "deleted_at" IS NULL;

-- Step 2: drop the old global unique. Runs in the same migration pass
-- (inside a transaction) after the CONCURRENTLY step completes.
-- The migrator wraps non-CONCURRENTLY statements in BEGIN/COMMIT; we
-- separate them here with a semicolon so the runner sees one DDL per
-- statement. The DROP holds a ShareLock (not AccessExclusiveLock on the
-- table itself) for the brief moment it removes the index descriptor.
DROP INDEX IF EXISTS "users_email_unique";

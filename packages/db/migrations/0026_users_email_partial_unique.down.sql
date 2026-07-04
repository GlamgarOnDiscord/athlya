-- Rollback: restore the global unique index on users.email.
--
-- WARNING: after 0026 was applied, the same email may appear in both an
-- active and a soft-deleted row (that is the whole point of the partial
-- index). Recreating a global UNIQUE(email) will fail with a duplicate-key
-- error if any such pair exists. Hard-delete the soft-deleted duplicates
-- before running this rollback:
--
--   DELETE FROM users
--   WHERE deleted_at IS NOT NULL
--     AND email IN (SELECT email FROM users WHERE deleted_at IS NULL);
--
-- CONCURRENTLY avoids a table lock during build. IF NOT EXISTS is idempotent
-- in case a partial rollback left the index behind.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_email_unique"
    ON "users" ("email");

DROP INDEX IF EXISTS "users_email_active_unique";

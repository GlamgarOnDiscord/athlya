-- Rollback: restore the global unique index on users.email.
--
-- WARNING: if any (active + soft-deleted) user pair share the same email
-- (valid after 0026 was applied), this CREATE will fail with a duplicate-key
-- error. Pre-emptively anonymise those rows before running this rollback:
--
--   UPDATE users SET email = NULL WHERE deleted_at IS NOT NULL
--   AND email IN (SELECT email FROM users WHERE deleted_at IS NULL);
--
-- CONCURRENTLY avoids a table lock during build. IF NOT EXISTS is idempotent
-- in case a partial rollback left the index behind.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "users_email_unique"
    ON "users" ("email");

DROP INDEX IF EXISTS "users_email_active_unique";

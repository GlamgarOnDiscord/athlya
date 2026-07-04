-- Rollback: restore the global unique index on users.email.
-- CONCURRENTLY avoids a table lock during build.
CREATE UNIQUE INDEX CONCURRENTLY "users_email_unique"
    ON "users" ("email");

DROP INDEX IF EXISTS "users_email_active_unique";

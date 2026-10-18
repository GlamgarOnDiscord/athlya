-- Rollback for 0041_users_email_nullable.sql (issue #628).
-- Rows already anonymised by the RGPD purge hold a NULL email and would
-- block SET NOT NULL. They get a unique, undeliverable placeholder on the
-- reserved `.invalid` TLD; they stay soft-deleted, so the partial unique
-- index `users_email_active_unique` does not cover them.
UPDATE "users"
   SET "email" = 'deleted.' || "id"::text || '@deleted.invalid'
 WHERE "email" IS NULL;
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;

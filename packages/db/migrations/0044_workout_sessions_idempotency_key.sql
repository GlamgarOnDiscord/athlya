-- =====================================================================
-- 0044 — idempotent workout session writes (issue #652)
--
-- `POST /v1/sessions` runs behind the idempotency middleware, but that
-- cache is a lookup-then-store: two requests with the same
-- `Idempotency-Key` that both miss the lookup (a mobile drain retry
-- racing the original request) would both insert a session. The key is
-- now stored with the session and a partial unique index turns the
-- second insert into a no-op; the adapter then returns the first row.
--
-- Expand only: the column is nullable and old Workers never write it,
-- so their inserts keep working during the canary. Rows without a key
-- (old Workers, clients that send none) are outside the partial index.
--
-- A plain (non-CONCURRENTLY) build keeps the column and its index in one
-- transaction. `ADD COLUMN` takes an ACCESS EXCLUSIVE lock held until
-- commit, so reads and writes on `workout_sessions` both wait for the
-- index build; the table is small, so that pause stays short.
-- =====================================================================

ALTER TABLE "workout_sessions" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "workout_sessions_user_idempotency_key_uniq"
    ON "workout_sessions" ("user_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

-- Rollback for 0044_workout_sessions_idempotency_key.sql (issue #652).
-- Roll the reservations Worker back to a version without #652 FIRST: its
-- POST /v1/sessions inserts this column and its ON CONFLICT needs the
-- partial index, so it fails once they are gone. Dropping the column
-- also drops the partial unique index built on it.
ALTER TABLE "workout_sessions" DROP COLUMN IF EXISTS "idempotency_key";

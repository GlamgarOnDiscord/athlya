-- Rollback for 0044_workout_sessions_idempotency_key.sql (issue #652).
DROP INDEX IF EXISTS "workout_sessions_user_idempotency_key_uniq";
ALTER TABLE "workout_sessions" DROP COLUMN IF EXISTS "idempotency_key";

-- Rollback for 0048_workout_sessions_external_source.sql (issue #688).
-- Roll the reservations Worker back to a version without #688 FIRST: its
-- POST /v1/sessions inserts these columns, so it fails once they are
-- gone. Dropping the columns also drops their CHECKs and the partial
-- unique index. Imported sessions stay, without their source.
ALTER TABLE "workout_sessions" DROP COLUMN IF EXISTS "external_id";
ALTER TABLE "workout_sessions" DROP COLUMN IF EXISTS "source";

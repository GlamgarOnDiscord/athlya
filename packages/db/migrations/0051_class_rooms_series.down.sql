-- Rollback for 0051_class_rooms_series.sql (issue #748).
-- Indexes and the FK go first, then the two class columns, then the
-- rooms table (its policies and grants go with it).
DROP INDEX IF EXISTS "classes_series_starts_at_idx";
DROP INDEX IF EXISTS "classes_coach_starts_at_idx";
DROP INDEX IF EXISTS "classes_room_starts_at_idx";
ALTER TABLE "classes" DROP CONSTRAINT IF EXISTS "classes_room_fk";
ALTER TABLE "classes" DROP COLUMN IF EXISTS "series_id";
ALTER TABLE "classes" DROP COLUMN IF EXISTS "room_id";
DROP TABLE IF EXISTS "rooms";

-- Rollback for 0054_notification_preferences.sql (issue #762).
--
-- Drops the function, then the column: members get every message again.

DROP FUNCTION IF EXISTS notification_preferences_of(uuid);

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_notification_preferences_object_check";
ALTER TABLE "users" DROP COLUMN IF EXISTS "notification_preferences";

-- =====================================================================
-- 0054: member notification preferences per message and channel
-- (issue #762, v1.4 roadmap "Réglages membre")
--
-- 1. `users.notification_preferences` stores the channels a member
--    turned off, as `{ "<message>": { "<channel>": false } }`. NULL or
--    a missing entry means "on", so every existing account keeps
--    receiving everything it receives today. The CHECK only enforces a
--    JSON object; the shape is validated by the shared Zod schema on
--    every write, and mandatory messages (payment failure, password
--    reset) are never read from it. `athlya_app` already holds UPDATE on
--    `users` (0004) and `users_update_own` (0001) limits a member to
--    their own row.
--
-- 2. `notification_preferences_of(uuid)` gives the notifications
--    consumer, which runs without tenant claims, the stored preferences
--    of a live recipient, `{}` when none, NULL for an unknown or deleted
--    user. Nothing else leaves the function.
--
-- Conventions (0032): owned by `athlya_owner` (BYPASSRLS),
-- `SET search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and
-- granted to `athlya_app` only.
--
-- Expand step: one nullable column and one function. An old Worker
-- neither reads nor writes them and keeps sending every message.
-- =====================================================================

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb;--> statement-breakpoint

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_notification_preferences_object_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_notification_preferences_object_check" CHECK (
    "notification_preferences" IS NULL OR jsonb_typeof("notification_preferences") = 'object'
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION notification_preferences_of(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(u.notification_preferences, '{}'::jsonb)
      FROM users u
     WHERE u.id = p_user_id
       AND u.deleted_at IS NULL
$$;--> statement-breakpoint

ALTER FUNCTION notification_preferences_of(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION notification_preferences_of(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notification_preferences_of(uuid) TO athlya_app;

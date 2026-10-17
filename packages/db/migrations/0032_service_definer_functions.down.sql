-- Rollback for 0032_service_definer_functions.sql (issue #224).
DROP FUNCTION IF EXISTS rgpd_restamp_user_deleted(uuid, timestamptz);
DROP FUNCTION IF EXISTS rgpd_delete_idempotency_keys(uuid);
DROP FUNCTION IF EXISTS rgpd_delete_push_tokens(uuid);
DROP FUNCTION IF EXISTS rgpd_delete_workout_sessions(uuid);
DROP FUNCTION IF EXISTS rgpd_delete_reservations(uuid);
DROP FUNCTION IF EXISTS notification_recipient(uuid);
DROP FUNCTION IF EXISTS auth_consume_password_reset(text, uuid, text);
DROP FUNCTION IF EXISTS auth_bump_credentials_version(uuid);
DROP FUNCTION IF EXISTS auth_soft_delete_user(uuid);
DROP FUNCTION IF EXISTS auth_create_member(uuid, text, text, text, jsonb);
DROP FUNCTION IF EXISTS auth_find_studio_by_slug(text);
DROP FUNCTION IF EXISTS auth_find_user_by_id(uuid);
DROP FUNCTION IF EXISTS auth_find_active_user_by_email(text);

REVOKE UPDATE ("consumed_at") ON "password_reset_tokens" FROM athlya_owner;
REVOKE SELECT ON "password_reset_tokens" FROM athlya_owner;
REVOKE SELECT, DELETE ON "idempotency_keys" FROM athlya_owner;
REVOKE SELECT, DELETE ON "workout_sessions" FROM athlya_owner;
REVOKE SELECT, DELETE ON "reservations" FROM athlya_owner;
REVOKE SELECT, DELETE ON "push_tokens" FROM athlya_owner;
REVOKE UPDATE ("deleted_at", "credentials_version", "password_hash") ON "users" FROM athlya_owner;
REVOKE SELECT, INSERT ON "users" FROM athlya_owner;
REVOKE SELECT ON "studios" FROM athlya_owner;

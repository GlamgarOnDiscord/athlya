-- Rollback for 0033_auth_event_recording.sql (issue #411).
DROP FUNCTION IF EXISTS auth_record_event(jsonb);
DROP FUNCTION IF EXISTS auth_soft_delete_user_with_event(uuid, jsonb);
DROP FUNCTION IF EXISTS auth_create_member_with_event(uuid, uuid, text, text, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS auth_outbox_insert(jsonb, text[]);
REVOKE SELECT ("event_id") ON "outbox" FROM athlya_owner;
REVOKE INSERT ON "outbox" FROM athlya_owner;

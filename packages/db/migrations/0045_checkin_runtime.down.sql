-- Rollback for 0045_checkin_runtime.sql (issue #654).
DROP FUNCTION IF EXISTS checkin_mark_reservation(uuid, timestamptz);
REVOKE UPDATE ("checked_in_at") ON "reservations" FROM athlya_owner;

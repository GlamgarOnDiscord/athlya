-- Rollback for 0040_reservation_waitlist_runtime.sql (issue #117).
DROP FUNCTION IF EXISTS capacity_reconcile_snapshot();
DROP FUNCTION IF EXISTS reservation_waitlist_ahead(uuid, timestamptz);
DROP FUNCTION IF EXISTS reservation_promote_oldest_waitlist(uuid);
DROP FUNCTION IF EXISTS reservation_lock_class_for_cancel(uuid);
REVOKE UPDATE ("status") ON "reservations" FROM athlya_owner;
REVOKE UPDATE ("version") ON "classes" FROM athlya_owner;
REVOKE SELECT ON "classes" FROM athlya_owner;

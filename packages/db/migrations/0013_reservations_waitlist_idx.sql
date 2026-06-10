-- =====================================================================
-- Athlya Platform — composite index for waitlist count query (0013)
--
-- Issue #238. The waitlist count query on bookClass and cancelReservation
-- resolvers performs:
--   SELECT COUNT(*) FROM reservations
--   WHERE class_id = $1 AND status = 'waitlist'
--   ORDER BY created_at ASC
--   LIMIT 1;
-- With only the unique index on (class_id, user_id) Postgres must scan
-- all rows for the class and then filter on status. A composite partial
-- index on (class_id, status, created_at) covering the two hot statuses
-- (waitlist and confirmed) lets the planner satisfy both the filter and
-- the ORDER BY in a single index scan.
-- =====================================================================

CREATE INDEX "reservations_class_status_created_at_idx"
    ON "reservations" USING btree ("class_id", "status", "created_at")
    WHERE "status" IN ('waitlist', 'confirmed');

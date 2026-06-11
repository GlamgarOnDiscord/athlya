-- =====================================================================
-- Athlya Platform — composite indexes for waitlist count and RLS (0013)
--
-- Issue #238.
--
-- INDEX 1 — reservations_class_status_created_at_idx
-- The waitlist count query (countWaitlistAhead) performs:
--   SELECT COUNT(*) FROM reservations
--   WHERE class_id = $1
--     AND status = 'waitlist'
--     AND created_at < $2;
-- Without a covering index Postgres scans all rows for the class and
-- filters post-scan. The partial composite index below restricts to the
-- waitlist slice (covering both the equality predicates and the range
-- filter on created_at) so the planner can satisfy the full WHERE in a
-- single index range scan.
--
-- INDEX 2 — classes_id_studio_idx
-- The reservations_read_admin_same_studio RLS policy evaluates:
--   EXISTS (SELECT 1 FROM classes c
--           WHERE c.id = reservations.class_id
--             AND c.studio_id = app_studio_id())
-- for every row. A covering index on (id, studio_id) makes this an
-- O(1) index-only lookup per row rather than a heap fetch.
--
-- Both indexes use CONCURRENTLY to avoid an exclusive lock on the
-- hot-path tables. CONCURRENTLY cannot run inside a transaction block;
-- run this migration outside an open transaction (psql -f or a
-- migrator that supports non-transactional DDL).
-- =====================================================================

CREATE INDEX CONCURRENTLY "reservations_class_status_created_at_idx"
    ON "reservations" USING btree ("class_id", "status", "created_at")
    WHERE "status" = 'waitlist';

CREATE INDEX CONCURRENTLY "classes_id_studio_idx"
    ON "classes" USING btree ("id", "studio_id")
    WHERE "deleted_at" IS NULL;

-- =====================================================================
-- Athlya Platform — partial index for confirmed reservation count (0025)
--
-- Issue #413. The `enforce_class_capacity()` BEFORE INSERT/UPDATE trigger
-- (migration 0008) counts confirmed reservations per class:
--
--   SELECT count(*) FROM reservations
--   WHERE class_id = NEW.class_id
--     AND status = 'confirmed'
--     AND (TG_OP = 'INSERT' OR id IS DISTINCT FROM NEW.id);
--
-- Without an index the trigger performs a sequential scan of all
-- reservations for the class and filters post-scan. Under a hot-class
-- release this query runs inside a SELECT ... FOR UPDATE lock on the
-- class row, so every concurrent booking waits for the previous one to
-- complete the scan. On a class with a long reservation history the
-- scan cost dominates p99 latency.
--
-- The partial index below restricts to the confirmed slice. The planner
-- can satisfy:
--   WHERE class_id = $1 AND status = 'confirmed'
-- with a single index range scan, turning the count from O(class rows)
-- to O(confirmed rows for the class). For most classes confirmed rows
-- are bounded by capacity (≤ 10 000 per migration 0024), so the scan
-- is always small.
--
-- The `id != $id` guard in the UPDATE branch (TG_OP = 'UPDATE') adds
-- one index probe to exclude the row being updated — still O(1).
--
-- CONCURRENTLY avoids an exclusive lock on the reservations table.
-- Cannot run inside a transaction; the migrator must execute this
-- statement outside an open transaction block.
-- =====================================================================

CREATE INDEX CONCURRENTLY "reservations_class_confirmed_idx"
    ON "reservations" USING btree ("class_id")
    WHERE "status" = 'confirmed';

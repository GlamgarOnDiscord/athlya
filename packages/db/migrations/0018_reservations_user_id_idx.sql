-- =====================================================================
-- Athlya Platform — index on reservations.user_id (0018)
--
-- Issue #306. GET /v1/reservations/me filters by user_id and orders by
-- created_at DESC. Without a dedicated index this is a sequential scan
-- that degrades non-linearly as the reservations table grows.
--
-- Index strategy:
--   (user_id, created_at DESC) WHERE deleted_at IS NULL
--
-- The partial index on non-deleted rows matches the WHERE clause in the
-- listMyReservations query and keeps the index footprint small. Covering
-- created_at allows index-only scans for the ORDER BY clause.
--
-- CONCURRENTLY avoids a full table lock on a live production database.
-- =====================================================================

CREATE INDEX CONCURRENTLY "reservations_user_id_created_at_idx"
    ON "reservations" USING btree ("user_id", "created_at" DESC)
    WHERE "deleted_at" IS NULL;

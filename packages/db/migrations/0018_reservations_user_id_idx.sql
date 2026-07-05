-- =====================================================================
-- Athlya Platform — index on reservations.user_id (0018)
--
-- Issue #306. GET /v1/reservations/me filters by user_id and orders by
-- created_at DESC. Without a dedicated index this is a sequential scan
-- that degrades non-linearly as the reservations table grows.
--
-- Index strategy:
--   (user_id, created_at DESC)
--
-- Covering created_at allows index-only scans for the ORDER BY clause.
-- reservations does not use a deleted_at soft-delete column (rows are
-- cancelled via status transitions, not removed), so no partial predicate.
--
-- CONCURRENTLY avoids a full table lock on a live production database.
-- =====================================================================

CREATE INDEX CONCURRENTLY "reservations_user_id_created_at_idx"
    ON "reservations" USING btree ("user_id", "created_at" DESC);

-- ============================================================================
-- Rollback: Migration 0007 — classes full-text search
-- ============================================================================

DROP INDEX IF EXISTS "classes_search_idx";

ALTER TABLE "classes" DROP COLUMN IF EXISTS "search_vector";

ALTER TABLE "classes" DROP COLUMN IF EXISTS "description";

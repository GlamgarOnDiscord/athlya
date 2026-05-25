-- ============================================================================
-- Migration 0007 — classes full-text search
-- ----------------------------------------------------------------------------
-- Adds a `description` column and a generated `search_vector` tsvector column
-- to the `classes` table, then builds a GIN index on it.
--
-- The vector is generated from `title || ' ' || coalesce(description, '')` in
-- the 'simple' dictionary (no language-specific stemming) so the index works
-- correctly for both French and English class names and for proper nouns
-- (e.g. "HIIT", "CrossFit", "Pilates") that stemmers would corrupt.
--
-- Requirement: CN.8.2 (full-text search on classes.title + description).
-- ============================================================================

ALTER TABLE "classes" ADD COLUMN "description" text;

--> statement-breakpoint
ALTER TABLE "classes"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce("title", '') || ' ' || coalesce("description", '')
    )
  ) STORED;

--> statement-breakpoint
CREATE INDEX "classes_search_idx" ON "classes" USING gin ("search_vector");

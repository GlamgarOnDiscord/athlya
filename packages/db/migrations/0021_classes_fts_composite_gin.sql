-- =====================================================================
-- Athlya Platform — composite GIN index for classes FTS (0021)
--
-- Issue #336. The existing `classes_search_idx` covers only `search_vector`.
-- The FTS query is always:
--   WHERE studio_id = $1 AND deleted_at IS NULL AND search_vector @@ tsquery
-- Without a composite index Postgres must choose between:
--   a) GIN bitmap scan on search_vector, then recheck studio_id — at scale
--      this loads unrelated-studio rows into the bitmap before discarding them.
--   b) Index scan on studio_id (btree), then heap-scan each row to check
--      search_vector — degrades linearly with studio class count.
--
-- The fix: enable btree_gin so Postgres can build a GIN index that covers
-- both a scalar column (studio_id, UUID) and a tsvector column in a single
-- structure. The planner can then satisfy the full two-predicate WHERE with
-- one index scan, dramatically reducing bitmap size and heap fetches.
--
-- Partial index (WHERE deleted_at IS NULL) further restricts index entries
-- to the active-class slice, which in a typical deployment is <20% of rows
-- (most classes are in the past). This keeps the index small and the GIN
-- posting lists short.
--
-- CONCURRENTLY avoids an exclusive table lock on the live classes table.
-- CONCURRENTLY cannot run inside a transaction block; run this migration
-- outside an open transaction (psql -f or a migrator that supports
-- non-transactional DDL).
-- =====================================================================

-- btree_gin adds GIN operator classes for scalar types (UUID, text, int…)
-- so they can participate in composite GIN indexes alongside tsvector.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Composite GIN index: covers studio_id equality + tsvector FTS in one scan.
-- Partial on deleted_at IS NULL — indexes only active classes (~20% of rows).
-- IF NOT EXISTS: safe to replay if the migration runner crashes after creation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "classes_studio_fts_idx"
    ON "classes" USING GIN ("studio_id", "search_vector")
    WHERE "deleted_at" IS NULL;

-- Drop the old single-column index — the new composite index supersedes it
-- for all queries that filter by studio_id (which is every production query).
-- Pure search_vector-only queries (no studio_id filter) would regress, but
-- no such queries exist in the codebase.
DROP INDEX CONCURRENTLY IF EXISTS "classes_search_idx";

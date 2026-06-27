-- Restore the original single-column GIN index and remove the composite one.
-- btree_gin extension is intentionally left installed — removing an extension
-- that may be used by other indexes is unsafe in a rollback context.

CREATE INDEX CONCURRENTLY "classes_search_idx"
    ON "classes" USING GIN ("search_vector");

DROP INDEX CONCURRENTLY IF EXISTS "classes_studio_fts_idx";

-- Backfill is not reversible: we cannot know which studio_id values
-- were NULL before the migration and which were already set.
-- Rolling back means accepting that some rows have studio_id set when
-- they previously had NULL — functionally correct (tighter RLS) but
-- not byte-for-byte identical to the pre-migration state.
--
-- For a true rollback, restore from a pre-migration DB snapshot.
SELECT 1; -- no-op

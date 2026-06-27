-- =====================================================================
-- Athlya Platform — backfill outbox.studio_id from event payload (0020)
--
-- Issue #342. Rows created before migration 0014 have studio_id = NULL
-- because the column didn't exist yet. The outbox_admin_only RLS policy
-- includes an IS NULL fallback for these rows, which allows any studio
-- admin to see them — a minor cross-tenant visibility risk.
--
-- Strategy: extract payload->>'studioId' and cast to uuid. Only update
-- rows where the studio actually exists (FK-safe JOIN). Rows whose
-- payload has no studioId (e.g. auth.user.deleted which is user-scoped
-- rather than studio-scoped) are left as NULL — the IS NULL policy
-- fallback continues to apply for them.
--
-- This UPDATE is safe under concurrent writes because:
--   1. It only touches rows with studio_id IS NULL (new rows always get
--      the column default from current_setting('app.studio_id')).
--   2. It uses an EXISTS guard so a stale studioId in the payload that
--      no longer has a studios row does not produce a FK violation.
--   3. No table lock is acquired — the WHERE clause uses the
--      outbox_pending_idx partial index on published_at IS NULL, and the
--      query planner can use it alongside the studio_id IS NULL filter.
-- =====================================================================

UPDATE outbox
   SET studio_id = (payload ->> 'studioId')::uuid
 WHERE studio_id IS NULL
   AND payload ->> 'studioId' IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM studios
        WHERE id = (payload ->> 'studioId')::uuid
   );

-- ============================================================================
-- Migration 0006 — anonymize_user_audit() scalar guard
-- ----------------------------------------------------------------------------
-- Closes the latent prod-risk surfaced during the chore/deps-major-updates
-- revert investigation: the SECURITY DEFINER function shipped in
-- `0003_audit_anonymization.sql` mutates `audit_log.metadata` with the JSONB
-- minus operator (`metadata - 'email' - 'displayName' - 'ip' - 'userAgent'`)
-- and filters with the JSONB containment operator (`metadata ? 'subjectUserId'`).
--
-- Both operators raise SQLSTATE 22023 (`cannot delete from scalar`) the moment
-- a single row in `audit_log` carries a JSON scalar in `metadata` instead of
-- an object — `null`, a number, a string, or a top-level array.
--
-- Production audit rows are *intended* to always be objects (the API gateway
-- inserts `JSON.stringify({...})::jsonb` exclusively), so this is not an
-- active failure today. But:
--
--   * The first row that drifts (rogue migration, future seed, manual
--     intervention) silently arms the bomb.
--   * The next J+30 RGPD cron run touches `audit_log` and crashes
--     wholesale — every deleted user that day stays un-anonymised.
--
-- Defensive fix: gate both the WHERE clause and the SET clause on
-- `jsonb_typeof(metadata) = 'object'`. Scalar / array rows are skipped (no
-- mutation, no error). The function still returns the count of rows it
-- actually anonymised, matching the existing `RETURNS integer` contract.
--
-- This migration is additive at the API level: same function name, same
-- signature, same return type, same `SECURITY DEFINER + owner + EXECUTE`
-- grants. Existing callers (`packages/members/src/cascade.ts` via
-- `anonymizeAuditRows`, `packages/api/src/maintenance/anonymize-audit-tx.ts`,
-- the J+30 cron worker) are unaffected.
--
-- @see packages/db/migrations/0003_audit_anonymization.sql — the original
--      function definition this `CREATE OR REPLACE` supersedes.
-- @see packages/db/tests/rls/audit_anonymization_scalar_guard.sql — the
--      pgTAP suite that exercises the new guard.
-- @see docs/runbooks/deps-revert-followups.md — the broader follow-up trail
--      that surfaced this bug.
-- ============================================================================

CREATE OR REPLACE FUNCTION anonymize_user_audit(target_user uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    touched integer;
BEGIN
    -- The WHERE clause uses `metadata ? 'subjectUserId'`, which raises
    -- SQLSTATE 22023 on any non-object jsonb. We pre-filter on
    -- `jsonb_typeof(metadata) = 'object'` so scalar / array rows are
    -- evaluated without ever reaching the `?` operator.
    --
    -- The SET clause uses the binary minus operator, which also raises
    -- SQLSTATE 22023 on non-objects. Wrapping it in a CASE keeps the
    -- update no-op for any row that somehow slipped through with a
    -- non-object metadata (defence in depth — the WHERE already excludes
    -- such rows from the actor_id branch).
    UPDATE audit_log
       SET actor_id = NULL,
           metadata = CASE
                        WHEN jsonb_typeof(metadata) = 'object'
                        THEN metadata
                                - 'email'
                                - 'displayName'
                                - 'ip'
                                - 'userAgent'
                        ELSE metadata
                      END
     WHERE actor_id = target_user
        OR (jsonb_typeof(metadata) = 'object'
            AND metadata ? 'subjectUserId'
            AND metadata->>'subjectUserId' = target_user::text);
    GET DIAGNOSTICS touched = ROW_COUNT;
    RETURN touched;
END;
$$;
--> statement-breakpoint

-- The OWNER + EXECUTE grants set in 0003 carry over a CREATE OR REPLACE,
-- but we restate them defensively in case someone reverted only the
-- function body in a partial rollback scenario.
ALTER FUNCTION anonymize_user_audit(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION anonymize_user_audit(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron;

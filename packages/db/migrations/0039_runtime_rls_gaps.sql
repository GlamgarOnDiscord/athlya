-- =====================================================================
-- 0039 — remaining runtime paths that failed under athlya_app (#117)
--
-- The RLS inventory added with 0038 surfaced two claim-less paths that
-- only worked under a BYPASSRLS / owner connection:
--
--   1. Password reset issuance. `password_reset_tokens` has no RLS
--      (migration 0005) but `athlya_app` only holds SELECT on it, so
--      the invalidate-then-insert of a new token failed with 42501.
--      The flow is pre-authentication like the rest of the auth
--      service, so it gets the same treatment as 0032: one narrow
--      SECURITY DEFINER function per operation.
--        - `auth_issue_password_reset` — invalidate the user's active
--          tokens and insert the new one atomically (issue #522
--          semantics), only for a live user, with a TTL capped at 24 h.
--          This also fixes re-issuance: the adapter's single-statement
--          CTE (UPDATE + INSERT) tripped the one-active-token index
--          (0029) with 23505 whenever the user already had an active
--          token.
--        - `auth_find_password_reset` — the active-token lookup, so the
--          adapter no longer reads the table directly.
--   2. The RGPD Article 17 cascade anonymised `audit_log` with a raw
--      UPDATE. `audit_no_update` (`USING (false)`) and the missing
--      UPDATE grant turn that into a silent no-op / 42501 under
--      `athlya_app`. The sanctioned path is `anonymize_user_audit()`
--      (migration 0003), which is granted to `athlya_cron` only.
--      Rather than widening that grant, `rgpd_anonymize_user_audit`
--      wraps it with the same guard as the other `rgpd_*` functions
--      (0032): it is a no-op unless the user is already soft-deleted,
--      so a forged or replayed `auth.user.deleted` event cannot strip
--      a live account's audit trail.
--
-- Conventions (0032): owner `athlya_owner`, `SET search_path = public,
-- pg_temp`, EXECUTE revoked from PUBLIC and granted to `athlya_app`.
--
-- Additive only (expand step): `athlya_app` keeps its SELECT on
-- `password_reset_tokens` so old Workers still read tokens during the
-- canary. Revoking it is the contract step, once no Worker reads the
-- table directly.
-- =====================================================================

GRANT INSERT ON "password_reset_tokens" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 1. Password reset issuance and lookup
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_issue_password_reset(
    p_user_id uuid,
    p_token_hash text,
    p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_expires_at <= now() OR p_expires_at > now() + interval '24 hours' THEN
        RAISE EXCEPTION 'password reset expiry must be within the next 24 hours'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NULL) THEN
        RETURN false;
    END IF;

    -- Two statements, not a data-modifying CTE: within one statement the
    -- INSERT's unique check still sees the invalidated row as active and
    -- `password_reset_tokens_user_active_uidx` (0029) raises 23505. Both
    -- run in the caller's transaction, so they still commit together.
    UPDATE password_reset_tokens
       SET consumed_at = now()
     WHERE user_id = p_user_id
       AND consumed_at IS NULL;

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (p_user_id, p_token_hash, p_expires_at);

    RETURN true;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_find_password_reset(p_token_hash text)
RETURNS TABLE (user_id uuid, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT t.user_id, t.expires_at
      FROM password_reset_tokens t
     WHERE t.token_hash = p_token_hash
       AND t.consumed_at IS NULL
       AND t.expires_at > now()
     LIMIT 1
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. RGPD cascade — audit_log anonymisation for a deleted user only
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rgpd_anonymize_user_audit(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL) THEN
        RETURN 0;
    END IF;
    RETURN anonymize_user_audit(p_user_id);
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Ownership and execute grants
-- ---------------------------------------------------------------------

ALTER FUNCTION auth_issue_password_reset(uuid, text, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_issue_password_reset(uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_issue_password_reset(uuid, text, timestamptz) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION auth_find_password_reset(text) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_find_password_reset(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_find_password_reset(text) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION rgpd_anonymize_user_audit(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION rgpd_anonymize_user_audit(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rgpd_anonymize_user_audit(uuid) TO athlya_app;

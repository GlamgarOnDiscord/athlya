-- Rollback for 0039_runtime_rls_gaps.sql (issue #117).
DROP FUNCTION IF EXISTS rgpd_anonymize_user_audit(uuid);
DROP FUNCTION IF EXISTS auth_find_password_reset(text);
DROP FUNCTION IF EXISTS auth_issue_password_reset(uuid, text, timestamptz);
REVOKE INSERT ON "password_reset_tokens" FROM athlya_owner;

-- Restore the migration 0006 body of anonymize_user_audit.
CREATE OR REPLACE FUNCTION anonymize_user_audit(target_user uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    touched integer;
BEGIN
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

ALTER FUNCTION anonymize_user_audit(uuid) OWNER TO athlya_owner;
REVOKE ALL ON FUNCTION anonymize_user_audit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron;

-- Reverse migration 0006. Restores the original function body from
-- 0003_audit_anonymization.sql. Same OWNER, REVOKE and GRANT statements
-- as the forward migration so the privilege topology is unchanged.

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
           metadata = metadata
                      - 'email'
                      - 'displayName'
                      - 'ip'
                      - 'userAgent'
     WHERE actor_id = target_user
        OR (metadata ? 'subjectUserId'
            AND metadata->>'subjectUserId' = target_user::text);
    GET DIAGNOSTICS touched = ROW_COUNT;
    RETURN touched;
END;
$$;

ALTER FUNCTION anonymize_user_audit(uuid) OWNER TO athlya_owner;
REVOKE ALL ON FUNCTION anonymize_user_audit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION anonymize_user_audit(uuid) TO athlya_cron;

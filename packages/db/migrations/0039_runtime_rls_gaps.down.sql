-- Rollback for 0039_runtime_rls_gaps.sql (issue #117).
DROP FUNCTION IF EXISTS rgpd_anonymize_user_audit(uuid);
DROP FUNCTION IF EXISTS auth_find_password_reset(text);
DROP FUNCTION IF EXISTS auth_issue_password_reset(uuid, text, timestamptz);
REVOKE INSERT ON "password_reset_tokens" FROM athlya_owner;

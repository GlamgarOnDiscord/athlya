-- Rollback of 0043: drop the reset-request recorder and the per-request
-- issuance. Pending `auth.password_reset.requested` outbox rows stay in
-- place; a Worker without the consumer quarantines them on the DLQ.
DROP FUNCTION IF EXISTS auth_issue_password_reset_for_request(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS auth_request_password_reset(text, uuid);
REVOKE UPDATE ("expires_at") ON "password_reset_tokens" FROM athlya_owner;

-- Rollback of 0042: drop the reset-request recorder. Pending
-- `auth.password_reset.requested` outbox rows stay in place; a Worker
-- without the consumer quarantines them on the DLQ.
DROP FUNCTION IF EXISTS auth_request_password_reset(text, uuid);

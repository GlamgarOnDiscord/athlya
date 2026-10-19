-- Rollback for 0047_idempotency_keys_purge.sql (audit S4-011).
DROP FUNCTION IF EXISTS idempotency_purge_expired(integer);

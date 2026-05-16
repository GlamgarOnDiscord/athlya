-- Reverse migration 0005. Drops both additive changes idempotently.

DROP INDEX IF EXISTS idx_users_audit_anonymized_pending;
ALTER TABLE users DROP COLUMN IF EXISTS audit_anonymized_at;

DROP INDEX IF EXISTS idx_password_reset_tokens_expired;
DROP INDEX IF EXISTS idx_password_reset_tokens_user_id;
DROP TABLE IF EXISTS password_reset_tokens;

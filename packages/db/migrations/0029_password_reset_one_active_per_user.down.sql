-- Reverse migration 0029 — drop the partial unique index on active tokens.
DROP INDEX IF EXISTS password_reset_tokens_user_active_uidx;

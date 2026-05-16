-- ============================================================================
-- Migration 0005 — Password reset tokens + audit-anonymise watermark
-- Sprint 7 / Vague 35 — finalises Sprint 6 partials S2-006 + S5-003.
-- ============================================================================
--
-- This migration ships the persistence layer needed by:
--
--   1. The forgot-password flow (`packages/auth/src/forgot-password.ts`,
--      Sprint 6 SP6.3, audit finding S2-006). Adds the
--      `password_reset_tokens` table + index.
--
--   2. The audit-log anonymisation cron driver
--      (`packages/api/src/maintenance/audit-anonymize.ts`, Sprint 6
--      SP6.2, audit finding S5-003). Adds the `users.audit_anonymized_at`
--      watermark column so the cron can skip already-processed users.
--
-- Both changes are additive (`ADD COLUMN`, `CREATE TABLE`) so the
-- migration is safe to apply against a live database without a
-- maintenance window. The companion `.down.sql` reverses both
-- statements idempotently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. password_reset_tokens — Sprint 7 SP7.2 / S2-006
-- ---------------------------------------------------------------------------
--
-- Storage shape:
--
--   id          UUID PK              random v7 — never exposed to the client.
--   user_id     UUID FK ON users.id  one user may have many tokens (e.g. user
--                                    requests reset twice in a row before
--                                    consuming the first email).
--   token_hash  TEXT NOT NULL UNIQUE SHA-256 hex of the plain token. The
--                                    plain token is NEVER persisted — same
--                                    posture as the session sid storage.
--   expires_at  TIMESTAMPTZ NOT NULL TTL = 1 hour from request (default in
--                                    `forgot-password.ts`).
--   consumed_at TIMESTAMPTZ NULL     stamped on successful confirm. Used by
--                                    the SQL filter to ensure single-use.
--   requested_at TIMESTAMPTZ NOT NULL DEFAULT now()  forensic timeline.
--
-- The unique index on `token_hash` doubles as the lookup index used by
-- `findActiveTokenByHash`. The composite filter `consumed_at IS NULL AND
-- expires_at > NOW()` is the active-token selector — adding a partial
-- index would be premature optimisation; the table stays small (rows
-- are consumed within an hour or expire).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on user_id so the rate-limit guard ("max 3 reset requests per
-- email per 24h" — wired at the route layer) and the GDPR cascade
-- (`DELETE password_reset_tokens WHERE user_id = $1`) are both O(log n).
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
    ON password_reset_tokens (user_id);

-- Partial index on expires_at for the cron sweeper (deletes rows where
-- `expires_at < now() - interval '30 days'`). Partial filter keeps the
-- index small — only stale rows occupy index entries.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expired
    ON password_reset_tokens (expires_at)
    WHERE consumed_at IS NULL;

-- Forbid UPDATE on consumed_at: the only legitimate write is via the
-- `consumeAndResetPassword` repo method which uses a row-level lock.
-- Concurrent two consumes of the same token would race; the SQL filter
-- on the UPDATE statement (`consumed_at IS NULL`) resolves the race
-- atomically — no trigger needed.

-- RLS — `password_reset_tokens` is a system-level surface (only the
-- auth service, never user-scoped queries). We DON'T enable RLS here
-- because the `athlya_app` role NEVER selects from this table directly
-- — only the auth service path goes through it via the Drizzle
-- adapter (which runs `SET LOCAL app.user_id = NULL` for
-- non-tenant-scoped operations). Enabling RLS would force every
-- read/write through a permissive policy that adds zero security and
-- breaks the rate-limit logic.

-- ---------------------------------------------------------------------------
-- 2. users.audit_anonymized_at — Sprint 7 SP7.2 / S5-003
-- ---------------------------------------------------------------------------
--
-- Watermark column read by `runAuditAnonymisationCycle` to skip users
-- whose audit rows have already been anonymised. The driver SELECT is:
--
--   WHERE deleted_at IS NOT NULL
--     AND deleted_at < now() - 30 days
--     AND COALESCE(audit_anonymized_at, '1970-01-01') < deleted_at
--
-- The watermark is updated AFTER the per-user anonymisation succeeds,
-- so a second cron tick for the same user is a no-op. Setting the
-- value to `< deleted_at` (instead of `now()`) future-proofs against
-- a user who soft-deletes, recovers (currently impossible — deletion
-- is permanent — but the schema stays correct against future feature
-- additions), then soft-deletes again: the second deletion bumps
-- `deleted_at` past the watermark, which re-arms the cron.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS audit_anonymized_at TIMESTAMPTZ NULL;

-- Partial index on the cron query — only soft-deleted users are
-- candidates, so we skip every active user.
CREATE INDEX IF NOT EXISTS idx_users_audit_anonymized_pending
    ON users (deleted_at)
    WHERE deleted_at IS NOT NULL AND audit_anonymized_at IS NULL;

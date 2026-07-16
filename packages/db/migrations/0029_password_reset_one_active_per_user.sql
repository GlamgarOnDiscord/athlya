-- ============================================================================
-- Migration 0029 — Enforce at-most-one active password-reset token per user
-- Fixes: issue #522 (sibling token invalidation / credential-recovery race)
-- ============================================================================
--
-- Security context
-- ----------------
-- Before this migration a user can accumulate many active reset tokens.
-- Completing a reset consumed only the presented token, leaving siblings
-- valid. An attacker retaining an older link could retake the account
-- after the owner completed a newer reset.
--
-- This migration adds a partial unique index that makes the at-most-one
-- invariant enforceable at the database level, independent of application
-- logic. The adapter (password-reset-repo-drizzle.ts) enforces the same
-- invariant with an atomic CTE that invalidates siblings before inserting;
-- this index is the last line of defence if application logic is bypassed
-- or if two concurrent issuance requests race faster than the CTE can
-- serialise.
--
-- The index is partial (WHERE consumed_at IS NULL) so it only covers
-- active tokens; consumed tokens are excluded and do not contribute to
-- the uniqueness constraint, preserving forensic history.
--
-- Expand/contract: additive only — no column changes, no data rewrites.
-- Safe to apply while the old Worker version is running.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_user_active_uidx
    ON password_reset_tokens (user_id)
    WHERE consumed_at IS NULL;

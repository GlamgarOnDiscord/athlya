-- =====================================================================
-- Athlya Platform — credentials_version column on users (0030)
--
-- Issue #520. Access tokens currently carry only sub/studio/role and
-- have no server-side revocation mechanism: after password reset,
-- logout-all, or account deletion, a captured access token remains
-- valid until its 15-minute TTL expires.
--
-- This migration adds a monotonic `credentials_version` counter to the
-- users table. On every security-critical event (password reset,
-- logout-all, soft-delete, role/studio change) the application
-- increments this counter in the same DB transaction. Access tokens
-- include the counter value as a `cv` claim; the jwtAuth middleware
-- rejects tokens whose `cv` is older than the current stored version
-- for mutation requests (POST/PUT/PATCH/DELETE).
--
-- Expand-only (canary-safe):
--   Old Workers that do not yet read `credentials_version` continue to
--   work — they just do not carry or validate the `cv` claim. The new
--   code path lands in the same deploy, so the overlap window is
--   sub-second (canary slots ≤ 5%).
--
-- Column choice: `integer NOT NULL DEFAULT 1` lets `credentials_version`
-- = credentials_version + 1` be a safe atomic increment, wraps at
-- ~2 billion (unreachable), and costs 4 bytes per user row.
-- =====================================================================

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "credentials_version" integer NOT NULL DEFAULT 1;

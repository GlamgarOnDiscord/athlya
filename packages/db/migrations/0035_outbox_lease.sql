-- =====================================================================
-- 0035 — outbox claim lease (issue #424)
--
-- The drain used to hold one transaction (and FOR UPDATE row locks on the
-- whole batch) open across every sequential `queue.send`; a degraded queue
-- turned that into minutes of locks and a pinned connection.
--
-- The drain now claims with a short statement that stamps `lease_until`
-- and commits immediately, sends outside any transaction, then marks the
-- delivered rows published. A row whose lease is in the future is not
-- claimable, so overlapping drains do not double-send; a drain that dies
-- mid-batch loses nothing — the lease expires and the next cycle
-- re-claims the row.
--
-- Expand-only: nullable column, no default, no constraint. Old Workers
-- ignore it (they keep their transactional claim) during the canary.
-- =====================================================================

ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "lease_until" timestamptz;--> statement-breakpoint

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
        GRANT UPDATE ("lease_until") ON "outbox" TO athlya_cron;
    END IF;
END
$$;

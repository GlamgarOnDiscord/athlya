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
-- Expand-only: nullable column, no default, no constraint.
--
-- Canary safety: an old Worker still runs the lease-unaware claim
-- (`SELECT … FOR UPDATE SKIP LOCKED` + `attempts + 1`) in a transaction.
-- After a new Worker's lease commits, the row is no longer locked, so the
-- old claim would pick it up and send it a second time. The
-- `outbox_skip_leased_claim` trigger drops such an UPDATE for a row whose
-- lease is still live (it bumps `attempts` without touching
-- `lease_until`): the row is absent from the old claim's RETURNING and is
-- not sent. Rows without a lease (all rows until a new Worker drains) are
-- untouched, so the old claim keeps working unchanged.
-- =====================================================================

ALTER TABLE "outbox" ADD COLUMN IF NOT EXISTS "lease_until" timestamptz;--> statement-breakpoint

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'athlya_cron') THEN
        GRANT UPDATE ("lease_until") ON "outbox" TO athlya_cron;
    END IF;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.outbox_skip_leased_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.lease_until > now()
       AND NEW.lease_until IS NOT DISTINCT FROM OLD.lease_until
       AND NEW.attempts > OLD.attempts THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS outbox_skip_leased_claim ON "outbox";--> statement-breakpoint

CREATE TRIGGER outbox_skip_leased_claim
    BEFORE UPDATE OF attempts ON "outbox"
    FOR EACH ROW
    EXECUTE FUNCTION public.outbox_skip_leased_claim();

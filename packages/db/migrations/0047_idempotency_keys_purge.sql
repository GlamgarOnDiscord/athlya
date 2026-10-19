-- =====================================================================
-- 0047 — purge expired idempotency keys from the cron (audit S4-011)
--
-- `idempotency_keys` rows carry a 24 h `expires_at` (Requirement 20.2),
-- and lookups already ignore expired rows (`expires_at > now()`), but
-- nothing ever deleted them: the "nightly sweeper" promised in
-- `packages/db/src/idempotency.ts` was never wired. Every mutation with
-- an `Idempotency-Key` therefore added a row, including its cached
-- response body, that stayed forever.
--
-- `idempotency_purge_expired(p_limit)` deletes at most `p_limit`
-- expired rows (oldest first, served by `idempotency_keys_expires_at_idx`)
-- and returns how many it deleted. The scheduled maintenance tick calls
-- it as `athlya_cron`, which has no grant on the table: the cron role
-- never reads a cached response, it can only remove rows that are
-- already expired. Two overlapping ticks are harmless: a row the other
-- tick deleted first is simply not counted. No `FOR UPDATE` lock: it
-- would need an UPDATE grant the owner does not hold and does not need.
--
-- Conventions (0032): owner `athlya_owner` (already holds SELECT and
-- DELETE on idempotency_keys since 0032), `SET search_path = public,
-- pg_temp`, EXECUTE revoked from PUBLIC and granted to athlya_cron only.
--
-- Additive only (expand step): one new function, no table, policy or
-- runtime-role table grant changes. Old Workers never call it.
-- =====================================================================

CREATE OR REPLACE FUNCTION idempotency_purge_expired(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    deleted integer;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 10000'
            USING ERRCODE = '22023';
    END IF;

    WITH expired AS (
        SELECT k.key, k.user_id
          FROM idempotency_keys AS k
         WHERE k.expires_at <= now()
         ORDER BY k.expires_at
         LIMIT p_limit
    )
    DELETE FROM idempotency_keys AS k
     USING expired AS e
     WHERE k.key = e.key
       AND k.user_id = e.user_id;

    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION idempotency_purge_expired(integer) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION idempotency_purge_expired(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION idempotency_purge_expired(integer) TO athlya_cron;

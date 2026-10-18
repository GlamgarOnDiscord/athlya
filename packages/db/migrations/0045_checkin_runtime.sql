-- =====================================================================
-- 0045 — QR check-in under the runtime role (issue #654, part of #648)
--
-- The check-in kiosk (task 12.4) is operated by staff: an admin or a
-- coach scans the member's QR and the API stamps `checked_in_at` on the
-- member's confirmed reservation (Requirement 11.6). Under `athlya_app`
-- a coach could find that reservation (`reservations_read_admin_same_
-- studio` admits admin and coach) but not stamp it:
-- `reservations_update_admin` only admits admins, so the UPDATE matched
-- zero rows. Widening that policy to coaches would let them rewrite any
-- column of any reservation of the studio (status, class_id, …).
--
-- `checkin_mark_reservation` is the narrow write instead: it sets
-- `checked_in_at` and nothing else, on one reservation that is
--   - confirmed and not yet checked in,
--   - attached to a live class of the caller's studio,
-- and only when the caller is an admin or a coach of that studio. Any
-- other case returns no row, which the service maps to a 4xx; a member
-- caller raises 42501.
--
-- It also keeps the per-member bound of issue #338: a member cannot be
-- checked in more than 5 times in the hour before `p_at`, across every
-- studio (the function runs as athlya_owner, so the count is not clipped
-- by RLS). The sixth stamp raises P0001 `checkin_limit_reached`. `checked_in_at` is not in the UPDATE OF list of
-- the capacity trigger, so the stamp never re-runs the capacity check.
--
-- Conventions (0032): owner `athlya_owner`, `SET search_path = public,
-- pg_temp`, EXECUTE revoked from PUBLIC and granted to one runtime role.
--
-- Additive only (expand step): no table, policy or runtime-role grant
-- changes, so old Workers keep their behaviour during the canary.
-- =====================================================================

GRANT UPDATE ("checked_in_at") ON "reservations" TO athlya_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION checkin_mark_reservation(p_reservation_id uuid, p_at timestamptz)
RETURNS TABLE (
    id uuid,
    class_id uuid,
    user_id uuid,
    status reservation_status,
    created_at timestamptz,
    cancelled_at timestamptz,
    checked_in_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.app_role() IS DISTINCT FROM 'admin'
       AND public.app_role() IS DISTINCT FROM 'coach' THEN
        RAISE EXCEPTION 'check-in requires an admin or coach caller'
            USING ERRCODE = '42501';
    END IF;

    IF (SELECT count(*)
          FROM reservations AS done
         WHERE done.user_id = (SELECT target.user_id FROM reservations AS target
                                WHERE target.id = p_reservation_id)
           AND done.checked_in_at > p_at - interval '1 hour'
           AND done.checked_in_at <= p_at) >= 5 THEN
        RAISE EXCEPTION 'checkin_limit_reached' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    UPDATE reservations AS r
       SET checked_in_at = p_at
      FROM classes AS c
     WHERE r.id = p_reservation_id
       AND r.status = 'confirmed'
       AND r.checked_in_at IS NULL
       AND c.id = r.class_id
       AND c.deleted_at IS NULL
       AND c.studio_id = public.app_studio_id()
    RETURNING r.id, r.class_id, r.user_id, r.status, r.created_at, r.cancelled_at, r.checked_in_at;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION checkin_mark_reservation(uuid, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION checkin_mark_reservation(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION checkin_mark_reservation(uuid, timestamptz) TO athlya_app;

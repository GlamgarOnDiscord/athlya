-- =====================================================================
-- 0040 — waitlist and capacity reconcile under the runtime roles (#117)
--
-- Three reservation paths only worked under a BYPASSRLS connection:
--
--   1. Member cancellation. `cancelReservation` locks the class with
--      `SELECT … FOR UPDATE`. A locking read must also pass the UPDATE
--      policies, and `classes_update_admin` only admits admins, so under
--      `athlya_app` with member claims the class read came back empty and
--      every member cancellation answered 404.
--   2. Waitlist promotion. The oldest waiter belongs to another member,
--      so `reservations_read_own` hid it (promotion never happened) and
--      `reservations_update_own` would have refused the UPDATE anyway.
--      The capacity check counted only the caller's own rows.
--   3. Waitlist position. `countWaitlistAhead` counted only the caller's
--      own rows, so every waiter was told they were first.
--
-- Each path gets one narrow SECURITY DEFINER function granted to
-- `athlya_app`. They run in the caller's transaction, so the capacity
-- trigger and the `reservation.promoted` outbox row the caller writes
-- next still commit or roll back together with the promotion. Every
-- function is scoped to the caller's studio (`app_studio_id()`) and to
-- a class the caller holds a reservation on (`app_user_id()`), and
-- returns only the columns the service needs.
--
-- The capacity drift reconcile cron reads `classes` and `reservations`
-- across tenants as `athlya_cron`, which has no grant on either table:
-- every tick failed with 42501. `capacity_reconcile_snapshot` returns
-- the per-class (capacity, confirmed) figures and is granted to
-- `athlya_cron` only. The reconcile heals Redis, not Postgres, so no
-- write function is needed.
--
-- Conventions (0032): owner `athlya_owner`, `SET search_path = public,
-- pg_temp`, EXECUTE revoked from PUBLIC and granted to one runtime role.
--
-- Additive only (expand step): no table, policy or grant of a runtime
-- role changes, so old Workers keep their behaviour during the canary.
-- =====================================================================

-- `athlya_owner` (BYPASSRLS) needs to read classes, and to lock and
-- promote reservations. A locking read requires UPDATE on at least one
-- column: `classes.version` is granted for the class row lock only, no
-- function writes it.
GRANT SELECT ON "classes" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("version") ON "classes" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("status") ON "reservations" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 1. Class lock for a cancellation
--
-- Returns the class start time and locks the class row, only for a live
-- class of the caller's studio on which the caller holds a reservation.
-- NULL otherwise, which the service maps to `not_found`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_lock_class_for_cancel(p_class_id uuid)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.starts_at
      FROM classes c
     WHERE c.id = p_class_id
       AND c.deleted_at IS NULL
       AND c.studio_id = public.app_studio_id()
       AND EXISTS (
           SELECT 1
             FROM reservations r
            WHERE r.class_id = c.id
              AND r.user_id = public.app_user_id()
       )
       FOR UPDATE OF c
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Waitlist promotion
--
-- Promotes the oldest waiter of a class (FIFO by created_at, then id)
-- when a confirmed seat is free. `SKIP LOCKED` keeps the Algorithm 2
-- invariant: two concurrent cancellations never pick the same waiter.
-- The UPDATE fires `enforce_class_capacity()`, which stays the
-- authoritative guard.
--
-- Exactly one row comes back:
--   ('promoted',    reservation_id, user_id)
--   ('no_waiter',   NULL, NULL)  — nobody to promote
--   ('no_capacity', NULL, NULL)  — the class is still full
--
-- A class outside the caller's studio, or one the caller holds no
-- reservation on, raises 42501 instead of reporting `no_waiter`, so a
-- misuse can never pass for an empty waitlist.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_promote_oldest_waitlist(p_class_id uuid)
RETURNS TABLE (outcome text, reservation_id uuid, user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_capacity integer;
    v_confirmed integer;
    v_waiter_id uuid;
    v_waiter_user uuid;
BEGIN
    SELECT c.capacity
      INTO v_capacity
      FROM classes c
     WHERE c.id = p_class_id
       AND c.deleted_at IS NULL
       AND c.studio_id = public.app_studio_id()
       AND EXISTS (
           SELECT 1
             FROM reservations r
            WHERE r.class_id = c.id
              AND r.user_id = public.app_user_id()
       )
       FOR UPDATE OF c;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'waitlist promotion not allowed for this class'
            USING ERRCODE = '42501';
    END IF;

    SELECT r.id, r.user_id
      INTO v_waiter_id, v_waiter_user
      FROM reservations r
     WHERE r.class_id = p_class_id
       AND r.status = 'waitlist'
     ORDER BY r.created_at, r.id
     LIMIT 1
       FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'no_waiter'::text, NULL::uuid, NULL::uuid;
        RETURN;
    END IF;

    SELECT count(*)::integer
      INTO v_confirmed
      FROM reservations r
     WHERE r.class_id = p_class_id
       AND r.status = 'confirmed';
    IF v_confirmed >= v_capacity THEN
        RETURN QUERY SELECT 'no_capacity'::text, NULL::uuid, NULL::uuid;
        RETURN;
    END IF;

    UPDATE reservations r
       SET status = 'confirmed'
     WHERE r.id = v_waiter_id;

    RETURN QUERY SELECT 'promoted'::text, v_waiter_id, v_waiter_user;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Waitlist position
--
-- Number of waiters of the class created strictly before
-- `p_created_at`. Only answers for a class of the caller's studio on
-- which the caller is waitlisted; NULL otherwise.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_waitlist_ahead(p_class_id uuid, p_created_at timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT (
        SELECT count(*)::integer
          FROM reservations r
         WHERE r.class_id = p_class_id
           AND r.status = 'waitlist'
           AND r.created_at < p_created_at
    )
     WHERE EXISTS (
         SELECT 1
           FROM classes c
          WHERE c.id = p_class_id
            AND c.studio_id = public.app_studio_id()
     )
       AND EXISTS (
         SELECT 1
           FROM reservations own
          WHERE own.class_id = p_class_id
            AND own.user_id = public.app_user_id()
            AND own.status = 'waitlist'
     )
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Capacity reconcile snapshot (cron only)
--
-- One row per active class (live, not started): capacity and confirmed
-- count. No tenant data beyond the class id leaves the function.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capacity_reconcile_snapshot()
RETURNS TABLE (class_id uuid, capacity integer, confirmed integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.id,
           c.capacity,
           (count(r.id) FILTER (WHERE r.status = 'confirmed'))::integer
      FROM classes c
      LEFT JOIN reservations r ON r.class_id = c.id
     WHERE c.deleted_at IS NULL
       AND c.starts_at > now()
     GROUP BY c.id, c.capacity
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Ownership and execute grants
-- ---------------------------------------------------------------------

ALTER FUNCTION reservation_lock_class_for_cancel(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_lock_class_for_cancel(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reservation_lock_class_for_cancel(uuid) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION reservation_promote_oldest_waitlist(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_promote_oldest_waitlist(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reservation_promote_oldest_waitlist(uuid) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION reservation_waitlist_ahead(uuid, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_waitlist_ahead(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reservation_waitlist_ahead(uuid, timestamptz) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION capacity_reconcile_snapshot() OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION capacity_reconcile_snapshot() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION capacity_reconcile_snapshot() TO athlya_cron;

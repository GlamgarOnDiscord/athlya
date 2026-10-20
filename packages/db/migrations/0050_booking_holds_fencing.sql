-- =====================================================================
-- 0050: seat holds, class schedule guard, version fencing and
-- waitlist promotion from the cron (issue #723, phase B of #713)
--
-- 1. Seat holds. A `pending` reservation keeps a seat for a bounded
--    time (`hold_expires_at`, at most 30 minutes ahead) while a client
--    finishes a checkout. `enforce_class_capacity()` now counts the
--    confirmed rows AND the unexpired holds of the class, so a hold
--    stops counting the instant it expires, without waiting for the
--    sweep. The trigger also refuses a hold without a valid expiry, a
--    hold that is extended, a non-pending row turned back into a hold,
--    and the confirmation of an expired hold. Confirming an active hold
--    never loses a capacity race: the seat it moves to `confirmed` was
--    already counted. `hold_expires_at` is cleared on every row that
--    is not `pending`, so a non-null expiry always means a hold.
--    The new partial unique index keeps one live row (confirmed,
--    waitlist or pending) per member and class; the 0028 index stays
--    until a contract step drops it.
--
-- 2. Class schedule guard. `guard_class_schedule()` refuses, on any
--    UPDATE of `classes` and whoever runs it: a capacity below the
--    confirmed rows plus the active holds, a new `starts_at` for a
--    class that already started or a `starts_at` in the past, and a
--    capacity or `starts_at` change that does not move `version`
--    forward. The service runs the same checks first and answers with
--    a clean 409/422; this trigger is the second line.
--
-- 3. Version fencing on bookings. `reservation_lock_class_for_booking`
--    locks the class row (the lock the capacity trigger takes) and
--    returns its start time, version and the database clock, so a
--    booking or a hold that carries the `classVersion` the member saw
--    is refused if the class changed in between. Scoped to the
--    caller's studio, granted to athlya_app only.
--
-- 4. Waitlist promotion from the cron. `reservation_sweep_holds_and_promote`
--    cancels expired holds, then promotes the oldest waiters (FIFO by
--    created_at, then id) into the free seats of upcoming classes, with
--    one `reservation.promoted` outbox row each. Class rows a booking
--    is holding are skipped (`SKIP LOCKED`) and retried next tick.
--    Granted to athlya_cron only: the cron role still has no grant on
--    `classes` or `reservations`. `reservation_promote_oldest_waitlist`
--    and `capacity_reconcile_snapshot` count the active holds too.
--
-- The new value `pending` is only used inside PL/pgSQL bodies, which
-- are not analysed until they first run: `ALTER TYPE ... ADD VALUE`
-- and a use of the value cannot share the migration transaction.
--
-- Conventions (0032): functions owned by `athlya_owner` (BYPASSRLS),
-- `SET search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and
-- granted to one runtime role. The trigger functions are owned by
-- `athlya_owner` too (they ran as the migration superuser before).
--
-- Expand step: one nullable column, one enum value, two indexes, two
-- triggers and new functions. An old Worker never writes a hold, keeps
-- bumping `version` on class edits and keeps its capacity check, so it
-- runs unchanged against this schema.
-- =====================================================================

ALTER TYPE "reservation_status" ADD VALUE IF NOT EXISTS 'pending';--> statement-breakpoint

ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "hold_expires_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_class_user_live_unique"
    ON "reservations" USING btree ("class_id", "user_id")
    WHERE "status" NOT IN ('cancelled', 'no_show');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "reservations_hold_expires_at_idx"
    ON "reservations" USING btree ("hold_expires_at")
    WHERE "hold_expires_at" IS NOT NULL;--> statement-breakpoint

-- The sweep cancels expired holds: status (granted in 0040),
-- cancelled_at and hold_expires_at.
GRANT UPDATE ("cancelled_at", "hold_expires_at") ON "reservations" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 1. Capacity trigger: confirmed rows plus active holds
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_class_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_capacity integer;
    v_occupied integer;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status = 'pending'
       AND NEW.status = 'confirmed'
       AND OLD.hold_expires_at <= now() THEN
        RAISE EXCEPTION 'hold_expired' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.status = 'pending' THEN
        IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'pending' THEN
            RAISE EXCEPTION 'hold_not_reopenable' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.hold_expires_at IS NULL
           OR NEW.hold_expires_at <= now()
           OR NEW.hold_expires_at > now() + interval '30 minutes' THEN
            RAISE EXCEPTION 'hold_expiry_out_of_range' USING ERRCODE = 'P0001';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.hold_expires_at > OLD.hold_expires_at THEN
            RAISE EXCEPTION 'hold_extension_refused' USING ERRCODE = 'P0001';
        END IF;
    ELSE
        NEW.hold_expires_at := NULL;
    END IF;

    IF NEW.status NOT IN ('confirmed', 'pending') THEN
        RETURN NEW;
    END IF;

    SELECT c.capacity
      INTO v_capacity
      FROM classes c
     WHERE c.id = NEW.class_id
       AND c.deleted_at IS NULL
       FOR UPDATE;

    IF v_capacity IS NULL THEN
        RAISE EXCEPTION 'class_not_found' USING ERRCODE = 'P0001';
    END IF;

    SELECT (SELECT count(*)
              FROM reservations r
             WHERE r.class_id = NEW.class_id
               AND r.status = 'confirmed'
               AND (TG_OP = 'INSERT' OR r.id IS DISTINCT FROM NEW.id))
         + (SELECT count(*)
              FROM reservations r
             WHERE r.class_id = NEW.class_id
               AND r.status = 'pending'
               AND r.hold_expires_at > now()
               AND (TG_OP = 'INSERT' OR r.id IS DISTINCT FROM NEW.id))
      INTO v_occupied;

    IF v_occupied >= v_capacity THEN
        RAISE EXCEPTION 'class_capacity_exceeded' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION public.enforce_class_capacity() OWNER TO athlya_owner;--> statement-breakpoint

DROP TRIGGER IF EXISTS reservations_enforce_capacity ON reservations;--> statement-breakpoint

CREATE TRIGGER reservations_enforce_capacity
    BEFORE INSERT OR UPDATE OF status, class_id, hold_expires_at ON reservations
    FOR EACH ROW
    EXECUTE FUNCTION enforce_class_capacity();--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Class schedule guard
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_class_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_occupied integer;
BEGIN
    IF NEW.capacity IS NOT DISTINCT FROM OLD.capacity
       AND NEW.starts_at IS NOT DISTINCT FROM OLD.starts_at THEN
        RETURN NEW;
    END IF;

    IF NEW.version <= OLD.version THEN
        RAISE EXCEPTION 'class_version_not_bumped' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
        IF OLD.starts_at <= now() THEN
            RAISE EXCEPTION 'class_already_started' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.starts_at <= now() THEN
            RAISE EXCEPTION 'class_starts_in_past' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF NEW.capacity < OLD.capacity THEN
        SELECT count(*)::integer
          INTO v_occupied
          FROM reservations r
         WHERE r.class_id = NEW.id
           AND (r.status = 'confirmed'
                OR (r.status = 'pending' AND r.hold_expires_at > now()));
        IF NEW.capacity < v_occupied THEN
            RAISE EXCEPTION 'class_capacity_below_booked' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION public.guard_class_schedule() OWNER TO athlya_owner;--> statement-breakpoint

DROP TRIGGER IF EXISTS classes_guard_schedule ON classes;--> statement-breakpoint

CREATE TRIGGER classes_guard_schedule
    BEFORE UPDATE OF capacity, starts_at ON classes
    FOR EACH ROW
    EXECUTE FUNCTION guard_class_schedule();--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Class lock for a fenced booking or a hold (athlya_app)
--
-- Locks a live class of the caller's studio and returns its start
-- time, version and `now()`. Empty for any other class, which the
-- service maps to `not_found`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_lock_class_for_booking(p_class_id uuid)
RETURNS TABLE (starts_at timestamptz, version integer, db_now timestamptz)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.starts_at, c.version, now()
      FROM classes c
     WHERE c.id = p_class_id
       AND c.deleted_at IS NULL
       AND c.studio_id = public.app_studio_id()
       FOR UPDATE OF c
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Waitlist promotion on cancellation: count the active holds
--
-- Same contract as 0040; only the occupied-seat count changes.
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
    v_occupied integer;
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
      INTO v_occupied
      FROM reservations r
     WHERE r.class_id = p_class_id
       AND (r.status = 'confirmed'
            OR (r.status = 'pending' AND r.hold_expires_at > now()));
    IF v_occupied >= v_capacity THEN
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
-- 5. Capacity reconcile snapshot: `confirmed` is the occupied seats
--
-- Same signature as 0040 (an old Worker reads the same columns). The
-- Redis counter is decremented by a hold, so the expected remaining
-- seats are `capacity - confirmed - active holds`.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION capacity_reconcile_snapshot()
RETURNS TABLE (class_id uuid, capacity integer, confirmed integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT c.id,
           c.capacity,
           (count(r.id) FILTER (
               WHERE r.status = 'confirmed'
                  OR (r.status = 'pending' AND r.hold_expires_at > now())
           ))::integer
      FROM classes c
      LEFT JOIN reservations r ON r.class_id = c.id
     WHERE c.deleted_at IS NULL
       AND c.starts_at > now()
     GROUP BY c.id, c.capacity;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 6. Hold expiry and waitlist promotion sweep (cron only)
--
-- Cancels at most `p_limit` expired holds (oldest expiry first), then
-- visits at most `p_limit` upcoming classes that have a waiter and a
-- free seat, locks each one (`SKIP LOCKED`: a class a booking holds is
-- left for the next tick), recounts under the lock and promotes the
-- oldest waiters into the free seats. Each promotion fires the
-- capacity trigger and writes its `reservation.promoted` outbox row
-- (studio of the class) in the same transaction. Returns one summary
-- row; no tenant data leaves the function.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reservation_sweep_holds_and_promote(p_limit integer)
RETURNS TABLE (expired_holds integer, promoted_waiters integer, promoted_classes integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_expired integer := 0;
    v_promoted integer := 0;
    v_classes integer := 0;
    v_class record;
    v_occupied integer;
    v_waiter record;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'p_limit must be between 1 and 1000'
            USING ERRCODE = '22023';
    END IF;

    WITH expired AS (
        SELECT r.id
          FROM reservations r
         WHERE r.status = 'pending'
           AND r.hold_expires_at <= now()
         ORDER BY r.hold_expires_at
         LIMIT p_limit
           FOR UPDATE SKIP LOCKED
    )
    UPDATE reservations r
       SET status = 'cancelled',
           cancelled_at = now()
      FROM expired e
     WHERE r.id = e.id;
    GET DIAGNOSTICS v_expired = ROW_COUNT;

    FOR v_class IN
        SELECT c.id, c.studio_id, c.capacity
          FROM classes c
         WHERE c.deleted_at IS NULL
           AND c.starts_at > now()
           AND EXISTS (
               SELECT 1
                 FROM reservations w
                WHERE w.class_id = c.id
                  AND w.status = 'waitlist'
           )
           AND c.capacity > (
               SELECT count(*)
                 FROM reservations r
                WHERE r.class_id = c.id
                  AND (r.status = 'confirmed'
                       OR (r.status = 'pending' AND r.hold_expires_at > now()))
           )
         ORDER BY c.starts_at, c.id
         LIMIT p_limit
           FOR UPDATE OF c SKIP LOCKED
    LOOP
        SELECT count(*)::integer
          INTO v_occupied
          FROM reservations r
         WHERE r.class_id = v_class.id
           AND (r.status = 'confirmed'
                OR (r.status = 'pending' AND r.hold_expires_at > now()));
        CONTINUE WHEN v_occupied >= v_class.capacity;

        v_classes := v_classes + 1;
        FOR v_waiter IN
            SELECT r.id, r.user_id
              FROM reservations r
             WHERE r.class_id = v_class.id
               AND r.status = 'waitlist'
             ORDER BY r.created_at, r.id
             LIMIT v_class.capacity - v_occupied
               FOR UPDATE SKIP LOCKED
        LOOP
            UPDATE reservations r
               SET status = 'confirmed'
             WHERE r.id = v_waiter.id;

            INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
            VALUES (
                gen_random_uuid()::text,
                'reservation.promoted',
                jsonb_build_object(
                    'reservationId', v_waiter.id,
                    'classId', v_class.id,
                    'userId', v_waiter.user_id
                ),
                now(),
                v_class.studio_id
            );
            v_promoted := v_promoted + 1;
        END LOOP;
    END LOOP;

    RETURN QUERY SELECT v_expired, v_promoted, v_classes;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 7. Ownership and execute grants
-- ---------------------------------------------------------------------

ALTER FUNCTION reservation_lock_class_for_booking(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_lock_class_for_booking(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reservation_lock_class_for_booking(uuid) TO athlya_app;--> statement-breakpoint

ALTER FUNCTION reservation_sweep_holds_and_promote(integer) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION reservation_sweep_holds_and_promote(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION reservation_sweep_holds_and_promote(integer) TO athlya_cron;

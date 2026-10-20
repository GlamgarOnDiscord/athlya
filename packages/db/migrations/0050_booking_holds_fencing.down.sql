-- Rollback for 0050_booking_holds_fencing.sql (issue #723).
--
-- Holds still open are cancelled first, while the 0050 trigger is in
-- place: the rows it leaves behind are ordinary cancelled reservations
-- the 0040 code understands. PostgreSQL cannot drop an enum value, so
-- `reservation_status` keeps `pending`; nothing writes it once the
-- functions and the column are gone.

UPDATE reservations
   SET status = 'cancelled',
       cancelled_at = coalesce(cancelled_at, now())
 WHERE status::text = 'pending';

DROP FUNCTION IF EXISTS reservation_sweep_holds_and_promote(integer);
DROP FUNCTION IF EXISTS reservation_lock_class_for_booking(uuid);

DROP TRIGGER IF EXISTS classes_guard_schedule ON classes;
DROP FUNCTION IF EXISTS public.guard_class_schedule();

-- 0008 capacity trigger: confirmed rows only.
CREATE OR REPLACE FUNCTION public.enforce_class_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  confirmed_count integer;
  class_cap integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;

  SELECT capacity
    INTO class_cap
    FROM classes
   WHERE id = NEW.class_id
     AND deleted_at IS NULL
     FOR UPDATE;

  IF class_cap IS NULL THEN
    RAISE EXCEPTION 'class_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*)::integer
    INTO confirmed_count
    FROM reservations
   WHERE class_id = NEW.class_id
     AND status = 'confirmed'
     AND (TG_OP = 'INSERT' OR id IS DISTINCT FROM NEW.id);

  IF confirmed_count >= class_cap THEN
    RAISE EXCEPTION 'class_capacity_exceeded' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_class_capacity() OWNER TO CURRENT_USER;

DROP TRIGGER IF EXISTS reservations_enforce_capacity ON reservations;

CREATE TRIGGER reservations_enforce_capacity
  BEFORE INSERT OR UPDATE OF status, class_id ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_class_capacity();

-- 0040 waitlist promotion: confirmed rows only.
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

-- 0040 reconcile snapshot: confirmed rows only.
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

DROP INDEX IF EXISTS reservations_hold_expires_at_idx;
DROP INDEX IF EXISTS reservations_class_user_live_unique;

REVOKE UPDATE ("cancelled_at", "hold_expires_at") ON "reservations" FROM athlya_owner;

ALTER TABLE "reservations" DROP COLUMN IF EXISTS "hold_expires_at";

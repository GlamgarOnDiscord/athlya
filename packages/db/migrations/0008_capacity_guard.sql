-- =====================================================================
-- Athlya Platform — reservation capacity guard (0008_capacity_guard)
--
-- Requirement 8.3 — authoritative PostgreSQL enforcement so
-- `count(confirmed) <= classes.capacity` holds even when the Redis
-- counter drifts, is evicted, or is bypassed.
--
-- Defence-in-depth: the booking service still uses Redis DECR as the
-- fast path; this trigger is the source of truth at commit time.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.enforce_class_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
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

DROP TRIGGER IF EXISTS reservations_enforce_capacity ON reservations;

CREATE TRIGGER reservations_enforce_capacity
  BEFORE INSERT OR UPDATE OF status ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_class_capacity();

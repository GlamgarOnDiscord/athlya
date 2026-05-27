-- Rollback: Migration 0008 — reservation capacity guard

DROP TRIGGER IF EXISTS reservations_enforce_capacity ON reservations;
DROP FUNCTION IF EXISTS public.enforce_class_capacity();

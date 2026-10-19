-- Rollback for 0046_workout_sessions_cardio.sql (issue #667).
-- Roll the Worker back to a version without #667 FIRST: its
-- POST /v1/sessions inserts `cardio` and its reads select it, so both
-- fail once the column is gone. Restores the 0034 `export_job_rows`
-- body before dropping the column it reads; dropping the column also
-- drops its CHECK constraint. Stored cardio summaries are lost.
CREATE OR REPLACE FUNCTION export_job_rows(
    p_job_id uuid,
    p_section text,
    p_after text,
    p_limit integer
)
RETURNS TABLE (cursor text, data jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user uuid;
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
    SELECT j.user_id INTO v_user FROM export_jobs j WHERE j.id = p_job_id AND j.status = 'running';
    IF v_user IS NULL THEN
        RETURN;
    END IF;

    IF p_section = 'reservations' THEN
        RETURN QUERY
        SELECT r.id::text, jsonb_build_object(
                   'id', r.id, 'classId', r.class_id, 'userId', r.user_id,
                   'status', r.status::text, 'createdAt', export_iso(r.created_at),
                   'cancelledAt', export_iso(r.cancelled_at), 'checkedInAt', export_iso(r.checked_in_at))
          FROM reservations r
         WHERE r.user_id = v_user AND (p_after IS NULL OR r.id > p_after::uuid)
         ORDER BY r.id
         LIMIT v_limit;
    ELSIF p_section = 'checkins' THEN
        RETURN QUERY
        SELECT r.id::text, jsonb_build_object(
                   'reservationId', r.id, 'classId', r.class_id,
                   'checkedInAt', export_iso(r.checked_in_at))
          FROM reservations r
         WHERE r.user_id = v_user AND r.checked_in_at IS NOT NULL
           AND (p_after IS NULL OR r.id > p_after::uuid)
         ORDER BY r.id
         LIMIT v_limit;
    ELSIF p_section = 'workout_sessions' THEN
        RETURN QUERY
        SELECT w.id::text, jsonb_build_object(
                   'id', w.id, 'userId', w.user_id, 'studioId', w.studio_id,
                   'startedAt', export_iso(w.started_at), 'durationMin', w.duration_min,
                   'exercises', w.exercises, 'notes', w.notes, 'createdAt', export_iso(w.created_at))
          FROM workout_sessions w
         WHERE w.user_id = v_user AND (p_after IS NULL OR w.id > p_after::uuid)
         ORDER BY w.id
         LIMIT v_limit;
    ELSIF p_section = 'audit_trail' THEN
        -- Rows the user authored, plus rows about them. For the latter the
        -- actor is withheld and only allow-listed metadata keys are kept,
        -- so free-form metadata cannot disclose the other actor.
        RETURN QUERY
        SELECT a.id::text, jsonb_build_object(
                   'id', a.id::text,
                   'actorId', CASE WHEN a.actor_id = v_user THEN a.actor_id END,
                   'action', a.action, 'targetType', a.target_type, 'targetId', a.target_id,
                   'metadata', CASE WHEN a.actor_id = v_user THEN a.metadata
                                    ELSE jsonb_strip_nulls(jsonb_build_object(
                                             'subjectUserId', a.metadata->'subjectUserId',
                                             'eventType', a.metadata->'eventType',
                                             'revision', a.metadata->'revision')) END,
                   'createdAt', export_iso(a.created_at))
          FROM audit_log a
         WHERE (a.actor_id = v_user OR a.metadata->>'subjectUserId' = v_user::text)
           AND (p_after IS NULL OR a.id > p_after::bigint)
         ORDER BY a.id
         LIMIT v_limit;
    ELSE
        RAISE EXCEPTION 'unknown export section %', p_section USING ERRCODE = '22023';
    END IF;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION export_job_rows(uuid, text, text, integer) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION export_job_rows(uuid, text, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION export_job_rows(uuid, text, text, integer) TO athlya_app;--> statement-breakpoint

ALTER TABLE "workout_sessions" DROP COLUMN IF EXISTS "cardio";

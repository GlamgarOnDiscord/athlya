-- =====================================================================
-- 0034 — RGPD export runtime under athlya_app (issue #498)
--
-- 0002 only gave `export_jobs` a read-own policy, so under the enforced
-- NOBYPASSRLS `athlya_app` role:
--   - the member's enqueue (INSERT) was refused with 42501;
--   - the queue consumer (no tenant claims) saw no job and every export
--     was acknowledged as `not_found`;
--   - the archive could not read any personal data.
--
-- Producer side: `export_jobs_insert_own` lets a member insert only
-- their own fresh `pending` row (the `members.export.requested` event
-- goes in the same statement, through `outbox_insert_tenant` from 0031).
--
-- Worker side: SECURITY DEFINER functions owned by `athlya_owner`
-- (conventions of 0032). The job id is the capability: personal data is
-- only readable for a job the caller has claimed (`running`), and only
-- for that job's user.
--   - export_job_claim: atomic pending → running with a 15 min lease,
--     so two concurrent deliveries cannot both run, and a crashed run is
--     reclaimed on redelivery. Each claim mints a fresh `claim_token`.
--   - export_job_complete / export_job_fail: transitions guarded by that
--     token, so a stale run whose lease was reclaimed cannot complete or
--     fail the newer run.
--   - export_job_profile / export_job_rows: the archive sections.
--
-- Additive only — canary safe: `claim_token` is a nullable column the
-- previous Worker never reads or writes.
-- =====================================================================

ALTER TABLE "export_jobs" ADD COLUMN IF NOT EXISTS "claim_token" uuid;--> statement-breakpoint

DROP POLICY IF EXISTS "export_jobs_insert_own" ON "export_jobs";--> statement-breakpoint
CREATE POLICY "export_jobs_insert_own" ON "export_jobs"
    FOR INSERT
    WITH CHECK (
        user_id = public.app_user_id()
        AND status = 'pending'
        AND started_at IS NULL
        AND completed_at IS NULL
        AND error IS NULL
        AND download_url IS NULL
        AND download_expires_at IS NULL
        AND claim_token IS NULL
    );
--> statement-breakpoint

GRANT SELECT ON "export_jobs" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("status", "started_at", "completed_at", "error", "download_url", "download_expires_at",
              "claim_token")
    ON "export_jobs" TO athlya_owner;--> statement-breakpoint

-- Internal: ISO-8601 UTC rendering matching the API's `toISOString()`.
CREATE OR REPLACE FUNCTION export_iso(p_ts timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION export_job_get(p_job_id uuid)
RETURNS TABLE (
    id uuid,
    user_id uuid,
    status text,
    requested_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    error text,
    download_url text,
    download_expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT j.id, j.user_id, j.status::text, j.requested_at, j.started_at, j.completed_at,
           j.error, j.download_url, j.download_expires_at
      FROM export_jobs j
     WHERE j.id = p_job_id
$$;
--> statement-breakpoint

-- Returns a fresh claim token to the caller that wins the transition,
-- NULL otherwise. A `running` job whose lease (started_at + 15 min)
-- expired is reclaimable, so a worker that died mid-run does not strand
-- the job; the reclaim rotates the token, which fences off the old run.
CREATE OR REPLACE FUNCTION export_job_claim(p_job_id uuid)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH claimed AS (
        UPDATE export_jobs j
           SET status = 'running', started_at = now(), claim_token = gen_random_uuid()
         WHERE j.id = p_job_id
           AND (j.status = 'pending'
                OR (j.status = 'running' AND j.started_at < now() - interval '15 minutes'))
        RETURNING j.claim_token
    )
    SELECT (SELECT claim_token FROM claimed)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION export_job_complete(
    p_job_id uuid,
    p_claim_token uuid,
    p_download_url text,
    p_download_expires_at timestamptz
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH done AS (
        UPDATE export_jobs j
           SET status = 'completed',
               completed_at = now(),
               download_url = p_download_url,
               download_expires_at = p_download_expires_at
         WHERE j.id = p_job_id AND j.status = 'running' AND j.claim_token = p_claim_token
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM done)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION export_job_fail(p_job_id uuid, p_claim_token uuid, p_error text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH failed AS (
        UPDATE export_jobs j
           SET status = 'failed', error = left(p_error, 500)
         WHERE j.id = p_job_id AND j.status = 'running' AND j.claim_token = p_claim_token
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM failed)
$$;
--> statement-breakpoint

-- Profile + consents of the job's user; NULL unless the job is running.
CREATE OR REPLACE FUNCTION export_job_profile(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'id', u.id,
               'studioId', u.studio_id,
               'email', u.email::text,
               'displayName', u.display_name,
               'avatarUrl', u.avatar_url,
               'role', u.role::text,
               'createdAt', export_iso(u.created_at),
               'consents', u.consents
           )
      FROM export_jobs j
      JOIN users u ON u.id = j.user_id
     WHERE j.id = p_job_id AND j.status = 'running'
$$;
--> statement-breakpoint

-- One keyset page of an archive section for the job's user. Empty unless
-- the job is running. `p_after` is the `cursor` of the previous page's
-- last row (NULL for the first page); pages are capped at 500 rows.
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

DO $$
DECLARE
    fn text;
BEGIN
    EXECUTE 'ALTER FUNCTION export_iso(timestamptz) OWNER TO athlya_owner';
    FOREACH fn IN ARRAY ARRAY[
        'export_job_get(uuid)',
        'export_job_claim(uuid)',
        'export_job_complete(uuid, uuid, text, timestamptz)',
        'export_job_fail(uuid, uuid, text)',
        'export_job_profile(uuid)',
        'export_job_rows(uuid, text, text, integer)'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO athlya_owner', fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO athlya_app', fn);
    END LOOP;
END
$$;

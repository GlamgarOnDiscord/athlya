-- =====================================================================
-- 0037 — post-merge review fixes for 0032 / 0033 (issue #609)
--
-- 1. `auth_outbox_insert` stored the whole envelope in `outbox.payload`
--    while every other producer stores the domain payload only. The
--    drain wraps `outbox.payload` into a fresh envelope, so a drained
--    `auth.user.deleted` arrived as `payload.payload.userId` and the
--    RGPD consumer acked it as invalid. It now stores `p_event->'payload'`.
--    Pending rows written in the old shape are unwrapped in place, and
--    `auth.user.deleted` rows already published in the old shape are
--    re-queued so their (idempotent) cascade finally runs.
-- 2. `auth_soft_delete_user_with_event` re-stamped `deleted_at` and
--    bumped `credentials_version` on every call. An already-deleted
--    user is now a no-op that keeps the original tombstone; an unknown
--    user still raises P0002.
-- 3. `auth_consume_password_reset` now refuses expired tokens.
-- 4. `rgpd_confirm_user_deleted` re-stamps an existing tombstone like
--    `rgpd_restamp_user_deleted` and reports whether the user is
--    soft-deleted, so the cascade can stop before its R2 / QStash side
--    effects for a live account.
--
-- Same signatures, owner, search_path and grants as before; the new
-- function is additive. Canary safe: old Workers call the same
-- functions and still drain correctly once the rows are unwrapped.
-- =====================================================================

CREATE OR REPLACE FUNCTION auth_outbox_insert(p_event jsonb, p_allowed_types text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_type text := p_event->>'type';
    v_id text := p_event->>'id';
    v_studio uuid;
    v_occurred timestamptz;
BEGIN
    IF v_type IS NULL OR NOT (v_type = ANY (p_allowed_types)) THEN
        RAISE EXCEPTION 'auth event type % not allowed here', v_type USING ERRCODE = '22023';
    END IF;
    IF v_id IS NULL OR length(v_id) = 0 OR length(v_id) > 128 THEN
        RAISE EXCEPTION 'auth event id missing or invalid' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_event->'payload') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'auth event payload missing or not an object' USING ERRCODE = '22023';
    END IF;
    BEGIN
        v_studio := (p_event->>'studioId')::uuid;
        v_occurred := (p_event->>'occurredAt')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'auth event studioId / occurredAt invalid' USING ERRCODE = '22023';
    END;
    IF v_studio IS NULL OR v_occurred IS NULL THEN
        RAISE EXCEPTION 'auth event studioId / occurredAt missing' USING ERRCODE = '22023';
    END IF;

    -- Domain payload only: the drain rebuilds the envelope from the
    -- row's event_id / event_type / occurred_at / studio_id columns.
    INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
    VALUES (v_id, v_type, p_event->'payload', v_occurred, v_studio)
    ON CONFLICT (event_id) DO NOTHING;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_soft_delete_user_with_event(p_user_id uuid, p_event jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_studio uuid;
    v_tombstoned boolean := true;
BEGIN
    -- The guard makes a concurrent second delete wait on the row lock,
    -- re-check `deleted_at` and match nothing.
    UPDATE users u
       SET deleted_at = now(),
           credentials_version = u.credentials_version + 1
     WHERE u.id = p_user_id
       AND u.deleted_at IS NULL
    RETURNING u.studio_id INTO v_studio;

    IF v_studio IS NULL THEN
        v_tombstoned := false;
        SELECT u.studio_id INTO v_studio FROM users u WHERE u.id = p_user_id;
        IF v_studio IS NULL THEN
            RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'P0002';
        END IF;
    END IF;

    IF p_event->'payload'->>'userId' IS DISTINCT FROM p_user_id::text
       OR p_event->>'studioId' IS DISTINCT FROM v_studio::text THEN
        RAISE EXCEPTION 'auth.user.deleted envelope does not match the user' USING ERRCODE = '22023';
    END IF;

    -- Already deleted: keep the original tombstone and its event.
    IF NOT v_tombstoned THEN
        RETURN;
    END IF;

    PERFORM auth_outbox_insert(p_event, ARRAY['auth.user.deleted']);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_consume_password_reset(
    p_token_hash text,
    p_user_id uuid,
    p_password_hash text
)
RETURNS SETOF uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH target AS (
        UPDATE password_reset_tokens
           SET consumed_at = now()
         WHERE token_hash = p_token_hash
           AND consumed_at IS NULL
           AND expires_at > now()
           AND user_id = p_user_id
        RETURNING user_id, id
    ),
    siblings AS (
        UPDATE password_reset_tokens
           SET consumed_at = now()
          FROM target
         WHERE password_reset_tokens.user_id = target.user_id
           AND password_reset_tokens.id <> target.id
           AND password_reset_tokens.consumed_at IS NULL
    ),
    updated AS (
        UPDATE users
           SET password_hash = p_password_hash,
               credentials_version = users.credentials_version + 1
          FROM target
         WHERE users.id = target.user_id
        RETURNING users.id
    )
    SELECT id FROM updated
$$;
--> statement-breakpoint

-- Re-stamps the tombstone of an already soft-deleted user and reports
-- whether there was one. Never tombstones a live account.
CREATE OR REPLACE FUNCTION rgpd_confirm_user_deleted(p_user_id uuid, p_deleted_at timestamptz)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH restamped AS (
        UPDATE users SET deleted_at = p_deleted_at
         WHERE id = p_user_id AND deleted_at IS NOT NULL
        RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM restamped)
$$;
--> statement-breakpoint

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'auth_soft_delete_user_with_event(uuid, jsonb)',
        'auth_consume_password_reset(text, uuid, text)',
        'rgpd_confirm_user_deleted(uuid, timestamptz)'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO athlya_owner', fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO athlya_app', fn);
    END LOOP;
    EXECUTE 'ALTER FUNCTION auth_outbox_insert(jsonb, text[]) OWNER TO athlya_owner';
    EXECUTE 'REVOKE ALL ON FUNCTION auth_outbox_insert(jsonb, text[]) FROM PUBLIC';
END
$$;
--> statement-breakpoint

-- Rows recorded by the 0033 body carry the whole envelope. Unwrap them
-- (the stored id / type match the row) and re-queue the deletions that
-- were already delivered in the broken shape: the cascade is
-- idempotent and only acts on a soft-deleted user.
UPDATE outbox
   SET payload = payload->'payload',
       published_at = CASE WHEN event_type = 'auth.user.deleted' THEN NULL ELSE published_at END
 WHERE event_type IN (
           'auth.user.registered',
           'auth.user.deleted',
           'auth.suspicious.refresh.reuse',
           'auth.suspicious.login.anomaly'
       )
   AND payload->>'id' = event_id
   AND payload->>'type' = event_type
   AND jsonb_typeof(payload->'payload') = 'object';

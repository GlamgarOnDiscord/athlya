-- Rollback for 0037_auth_outbox_review_fixes.sql (issue #609).
-- Restores the 0032 / 0033 bodies. The outbox rows unwrapped by the
-- forward migration keep the domain-payload shape, which every drain
-- version delivers correctly.
DROP FUNCTION IF EXISTS rgpd_confirm_user_deleted(uuid, timestamptz);
--> statement-breakpoint

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
    BEGIN
        v_studio := (p_event->>'studioId')::uuid;
        v_occurred := (p_event->>'occurredAt')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'auth event studioId / occurredAt invalid' USING ERRCODE = '22023';
    END;
    IF v_studio IS NULL OR v_occurred IS NULL THEN
        RAISE EXCEPTION 'auth event studioId / occurredAt missing' USING ERRCODE = '22023';
    END IF;

    INSERT INTO outbox (event_id, event_type, payload, occurred_at, studio_id)
    VALUES (v_id, v_type, p_event, v_occurred, v_studio)
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
BEGIN
    UPDATE users u
       SET deleted_at = now(),
           credentials_version = u.credentials_version + 1
     WHERE u.id = p_user_id
    RETURNING u.studio_id INTO v_studio;

    IF v_studio IS NULL THEN
        RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'P0002';
    END IF;
    IF p_event->'payload'->>'userId' IS DISTINCT FROM p_user_id::text
       OR p_event->>'studioId' IS DISTINCT FROM v_studio::text THEN
        RAISE EXCEPTION 'auth.user.deleted envelope does not match the user' USING ERRCODE = '22023';
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

-- =====================================================================
-- 0033 — atomic, RLS-safe auth event recording (issue #411)
--
-- Auth events used to be written to `outbox` by a separate statement
-- after the user mutation, through `athlya_app` with no tenant context:
-- the insert was refused by RLS, and even when it succeeded a failure
-- between the two commits could leave a deleted account with no durable
-- `auth.user.deleted` event (no RGPD cascade).
--
-- This migration records auth events through SECURITY DEFINER functions
-- (same conventions as 0032):
--
--   - `auth_create_member_with_event` / `auth_soft_delete_user_with_event`
--     perform the mutation AND the outbox insert in one statement, so the
--     compliance-critical `auth.user.*` events commit or roll back with
--     the user row.
--   - `auth_record_event` records the advisory `auth.suspicious.*`
--     events only; it refuses `auth.user.*` so those can never be
--     emitted without their mutation.
--
-- Every function validates the envelope (type, id, studioId, subject)
-- before writing. Additive only — canary safe.
-- =====================================================================

-- ON CONFLICT (event_id) needs SELECT on the arbiter column.
GRANT INSERT ON "outbox" TO athlya_owner;--> statement-breakpoint
GRANT SELECT ("event_id") ON "outbox" TO athlya_owner;--> statement-breakpoint

-- Internal helper: validated outbox insert. Owned by athlya_owner and
-- NOT granted to any runtime role — reachable only from the bodies below.
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

CREATE OR REPLACE FUNCTION auth_create_member_with_event(
    p_user_id uuid,
    p_studio_id uuid,
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_consents jsonb,
    p_event jsonb
)
RETURNS TABLE (
    id uuid,
    studio_id uuid,
    email text,
    display_name text,
    role text,
    password_hash text,
    deleted_at timestamptz,
    credentials_version integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_event->'payload'->>'userId' IS DISTINCT FROM p_user_id::text
       OR p_event->>'studioId' IS DISTINCT FROM p_studio_id::text THEN
        RAISE EXCEPTION 'auth.user.registered envelope does not match the new user' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    INSERT INTO users AS u (id, studio_id, email, display_name, password_hash, role, consents)
    VALUES (p_user_id, p_studio_id, p_email::citext, p_display_name, p_password_hash, 'member', p_consents)
    RETURNING u.id, u.studio_id, u.email::text, u.display_name, u.role::text,
              u.password_hash, u.deleted_at, u.credentials_version;

    PERFORM auth_outbox_insert(p_event, ARRAY['auth.user.registered']);
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

CREATE OR REPLACE FUNCTION auth_record_event(p_event jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM auth_outbox_insert(
        p_event,
        ARRAY['auth.suspicious.refresh.reuse', 'auth.suspicious.login.anomaly']
    );
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
    fn text;
BEGIN
    EXECUTE 'ALTER FUNCTION auth_outbox_insert(jsonb, text[]) OWNER TO athlya_owner';
    EXECUTE 'REVOKE ALL ON FUNCTION auth_outbox_insert(jsonb, text[]) FROM PUBLIC';
    FOREACH fn IN ARRAY ARRAY[
        'auth_create_member_with_event(uuid, uuid, text, text, text, jsonb, jsonb)',
        'auth_soft_delete_user_with_event(uuid, jsonb)',
        'auth_record_event(jsonb)'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO athlya_owner', fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO athlya_app', fn);
    END LOOP;
END
$$;

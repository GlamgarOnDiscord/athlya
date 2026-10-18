-- =====================================================================
-- 0043 — durable password-reset requests through the outbox (issue #645)
--
-- `POST /v1/auth/password-reset/request` used to look the account up,
-- issue the token and call Resend inside `ctx.waitUntil()`: a Resend
-- outage or an evicted isolate lost the email for good (#521 follow-up).
--
-- `auth_request_password_reset` records the request instead. It looks
-- up the live account by email and writes an
-- `auth.password_reset.requested` outbox row in the same statement,
-- through `auth_outbox_insert` (0033 / 0037). An unknown or soft-deleted
-- address writes nothing and returns false; the route answers 204 either
-- way, before this call runs. The drain then delivers the event to the
-- notifications lane, whose consumer mints the token, sends the email,
-- and is retried by the queue (`max_retries = 5`, then the DLQ).
--
-- The payload carries the account id only: no email address (S5-005)
-- and no token. The token is minted at delivery, so the outbox, the
-- queue and the DLQ never hold a bearer credential.
--
-- Conventions (0032): owner `athlya_owner`, `SET search_path = public,
-- pg_temp`, EXECUTE revoked from PUBLIC and granted to `athlya_app`.
-- Additive only (expand step): old Workers keep calling
-- `auth_issue_password_reset` directly and are unaffected.
-- =====================================================================

CREATE OR REPLACE FUNCTION auth_request_password_reset(p_email text, p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user uuid;
    v_studio uuid;
BEGIN
    IF p_event_id IS NULL THEN
        RAISE EXCEPTION 'password reset event id missing' USING ERRCODE = '22023';
    END IF;

    -- Same match as `auth_find_active_user_by_email` (0032 / 0041).
    SELECT u.id, u.studio_id INTO v_user, v_studio
      FROM users u
     WHERE u.email = p_email::citext
       AND u.deleted_at IS NULL
     LIMIT 1;

    IF v_user IS NULL THEN
        RETURN false;
    END IF;

    PERFORM auth_outbox_insert(
        jsonb_build_object(
            'id', p_event_id::text,
            'type', 'auth.password_reset.requested',
            'occurredAt', now(),
            'studioId', v_studio,
            'payload', jsonb_build_object('userId', v_user)
        ),
        ARRAY['auth.password_reset.requested']
    );
    RETURN true;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION auth_request_password_reset(text, uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_request_password_reset(text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_request_password_reset(text, uuid) TO athlya_app;

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
-- and no token. The token is derived at delivery from the event id, so
-- the outbox, the queue and the DLQ never hold a bearer credential, and
-- `auth_issue_password_reset_for_request` (below) lets a retried
-- delivery find its own token instead of invalidating it.
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
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- Token issuance for a recorded request (cubic review on #650)
--
-- The consumer derives the token from the request's event id (HMAC with
-- a Worker secret), so a retried delivery sends the same link and Resend
-- deduplicates it by idempotency key. A retry must therefore find its own
-- token instead of invalidating it:
--
--   'issued'     — new token stored (previous active tokens invalidated,
--                  issue #522), or this request's unconsumed token found
--                  again: its expiry is re-armed and it stays the only
--                  active token (issuing any other token consumes it).
--   'superseded' — this request's token was consumed: used, or replaced
--                  by a later request. Nothing to send.
--   'inactive'   — the account is deleted or unknown. Nothing to send.
--
-- `token_hash` is UNIQUE (0005), so the lookup is exact. A hash owned by
-- another user is refused.
-- ---------------------------------------------------------------------

GRANT UPDATE ("expires_at") ON "password_reset_tokens" TO athlya_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_issue_password_reset_for_request(
    p_user_id uuid,
    p_token_hash text,
    p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner uuid;
    v_consumed timestamptz;
BEGIN
    IF p_expires_at <= now() OR p_expires_at > now() + interval '24 hours' THEN
        RAISE EXCEPTION 'password reset expiry must be within the next 24 hours'
            USING ERRCODE = '22023';
    END IF;

    -- Lock order matches `auth_consume_password_reset` (0037): the user's
    -- token rows first, then the user row. Taking them the other way round
    -- (as 0039's issuance does) can deadlock against a concurrent
    -- confirmation. There is at most one unconsumed row per user (0029).
    PERFORM 1 FROM password_reset_tokens t
      WHERE t.user_id = p_user_id AND t.consumed_at IS NULL
      FOR UPDATE;

    -- The user lock serialises concurrent first issuances (no token row
    -- to lock yet), like auth_issue_password_reset (0039).
    PERFORM 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'inactive';
    END IF;

    SELECT t.user_id, t.consumed_at INTO v_owner, v_consumed
      FROM password_reset_tokens t
     WHERE t.token_hash = p_token_hash;

    IF FOUND THEN
        IF v_owner IS DISTINCT FROM p_user_id THEN
            RAISE EXCEPTION 'password reset token belongs to another user' USING ERRCODE = '22023';
        END IF;
        IF v_consumed IS NOT NULL THEN
            RETURN 'superseded';
        END IF;
        UPDATE password_reset_tokens
           SET expires_at = p_expires_at
         WHERE token_hash = p_token_hash;
        RETURN 'issued';
    END IF;

    UPDATE password_reset_tokens
       SET consumed_at = now()
     WHERE user_id = p_user_id
       AND consumed_at IS NULL;

    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (p_user_id, p_token_hash, p_expires_at);

    RETURN 'issued';
END;
$$;
--> statement-breakpoint

ALTER FUNCTION auth_issue_password_reset_for_request(uuid, text, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_issue_password_reset_for_request(uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_issue_password_reset_for_request(uuid, text, timestamptz) TO athlya_app;

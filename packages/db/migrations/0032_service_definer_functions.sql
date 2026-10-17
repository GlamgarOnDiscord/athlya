-- =====================================================================
-- 0032 — least-privilege service functions for athlya_app (issue #224)
--
-- Under the enforced `athlya_app` role (NOBYPASSRLS, FORCE RLS) three
-- families of queries run without tenant claims and therefore match
-- zero rows (or fail with 42501):
--
--   1. Pre-authentication auth flows (register, login, refresh,
--      password reset) — there is no `app.user_id` / `app.studio_id`
--      to scope to yet.
--   2. The notifications queue consumer — resolves the recipient of a
--      domain event, outside any HTTP request.
--   3. The RGPD Article 17 cascade queue consumer — purges the rows of
--      a user who already deleted their account.
--
-- Rather than widening the table policies (any query, any column), each
-- path gets one narrow SECURITY DEFINER function owned by
-- `athlya_owner` (BYPASSRLS, NOLOGIN — reachable only through these
-- bodies). The function signature IS the contract: fixed columns, fixed
-- predicates, no dynamic SQL.
--
-- Conventions (same as `anonymize_user_audit`, migration 0003):
--   - `SET search_path = public, pg_temp` pins name resolution.
--   - `REVOKE ALL ... FROM PUBLIC`, then `GRANT EXECUTE` to `athlya_app`.
--   - `athlya_owner` gets only the table privileges the bodies use.
--
-- Additive only: no column or policy changes, safe for canary rollout
-- (old Workers keep their raw queries until the new code ships).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table privileges for the function owner
-- ---------------------------------------------------------------------

GRANT SELECT ON "studios" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, INSERT ON "users" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("deleted_at", "credentials_version", "password_hash") ON "users" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, DELETE ON "push_tokens" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, DELETE ON "reservations" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, DELETE ON "workout_sessions" TO athlya_owner;--> statement-breakpoint
GRANT SELECT, DELETE ON "idempotency_keys" TO athlya_owner;--> statement-breakpoint
GRANT SELECT ON "password_reset_tokens" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("consumed_at") ON "password_reset_tokens" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Pre-authentication (auth service UserRepo)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_find_active_user_by_email(p_email text)
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.id, u.studio_id, u.email::text, u.display_name, u.role::text,
           u.password_hash, u.deleted_at, u.credentials_version
      FROM users u
     WHERE u.email = p_email::citext
       AND u.deleted_at IS NULL
     LIMIT 1
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_find_user_by_id(p_user_id uuid)
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
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.id, u.studio_id, u.email::text, u.display_name, u.role::text,
           u.password_hash, u.deleted_at, u.credentials_version
      FROM users u
     WHERE u.id = p_user_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_find_studio_by_slug(p_slug text)
RETURNS TABLE (id uuid, slug text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT s.id, s.slug, s.name FROM studios s WHERE s.slug = p_slug LIMIT 1
$$;
--> statement-breakpoint

-- Self-registration only ever creates members: the role is hard-coded so
-- the function cannot mint admins or coaches. A duplicate active email
-- surfaces as SQLSTATE 23505 from `users_email_active_unique`.
CREATE OR REPLACE FUNCTION auth_create_member(
    p_studio_id uuid,
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_consents jsonb
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
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO users (studio_id, email, display_name, password_hash, role, consents)
    VALUES (p_studio_id, p_email::citext, p_display_name, p_password_hash, 'member', p_consents)
    RETURNING users.id, users.studio_id, users.email::text, users.display_name,
              users.role::text, users.password_hash, users.deleted_at,
              users.credentials_version
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_soft_delete_user(p_user_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE users
       SET deleted_at = now(),
           credentials_version = credentials_version + 1
     WHERE id = p_user_id
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_bump_credentials_version(p_user_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE users SET credentials_version = credentials_version + 1 WHERE id = p_user_id
$$;
--> statement-breakpoint

-- Password reset confirmation (issue #522 semantics): consume the
-- presented token, invalidate its siblings and rotate the password in a
-- single statement. Returns the user id, or no row when the token was
-- already consumed / belongs to someone else.
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
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Notifications consumer — recipient of an event
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notification_recipient(p_user_id uuid)
RETURNS TABLE (id uuid, email text, consents jsonb, push_tokens text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT u.id,
           u.email::text,
           u.consents,
           COALESCE(
               ARRAY(SELECT t.token FROM push_tokens t
                      WHERE t.user_id = u.id AND t.deleted_at IS NULL
                      ORDER BY t.created_at),
               '{}'::text[]
           )
      FROM users u
     WHERE u.id = p_user_id
       AND u.deleted_at IS NULL
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. RGPD Article 17 cascade — only for users already soft-deleted
--
-- Every function is a no-op for a live account, so a forged or
-- replayed `auth.user.deleted` event cannot erase an active user's data.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rgpd_delete_reservations(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        DELETE FROM reservations r
         WHERE r.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL)
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rgpd_delete_workout_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        DELETE FROM workout_sessions w
         WHERE w.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL)
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rgpd_delete_push_tokens(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        DELETE FROM push_tokens t
         WHERE t.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL)
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rgpd_delete_idempotency_keys(p_user_id uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH d AS (
        DELETE FROM idempotency_keys k
         WHERE k.user_id = p_user_id
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL)
        RETURNING 1
    )
    SELECT count(*)::integer FROM d
$$;
--> statement-breakpoint

-- Re-stamps the tombstone of an already soft-deleted user; never
-- tombstones a live account (that path is `auth_soft_delete_user`).
CREATE OR REPLACE FUNCTION rgpd_restamp_user_deleted(p_user_id uuid, p_deleted_at timestamptz)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE users SET deleted_at = p_deleted_at
     WHERE id = p_user_id AND deleted_at IS NOT NULL
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Ownership and execute grants
-- ---------------------------------------------------------------------

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'auth_find_active_user_by_email(text)',
        'auth_find_user_by_id(uuid)',
        'auth_find_studio_by_slug(text)',
        'auth_create_member(uuid, text, text, text, jsonb)',
        'auth_soft_delete_user(uuid)',
        'auth_bump_credentials_version(uuid)',
        'auth_consume_password_reset(text, uuid, text)',
        'notification_recipient(uuid)',
        'rgpd_delete_reservations(uuid)',
        'rgpd_delete_workout_sessions(uuid)',
        'rgpd_delete_push_tokens(uuid)',
        'rgpd_delete_idempotency_keys(uuid)',
        'rgpd_restamp_user_deleted(uuid, timestamptz)'
    ] LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO athlya_owner', fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO athlya_app', fn);
    END LOOP;
END
$$;

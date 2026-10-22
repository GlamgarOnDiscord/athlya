-- =====================================================================
-- 0052: studio team roles, Manager and Accueil (issue #756)
--
-- 1. Two new `user_role` labels: `manager` (runs the studio day to day:
--    everything an admin does but billing, branding and changes to the
--    team) and `accueil` (front desk: check-in kiosk, attendance of every
--    class, members read only, planning read only). The capability
--    matrix lives in `@athlya/shared/roles`; the policies below mirror it.
--
-- 2. Two helpers the policies read: `app_is_manager()` (admin or
--    manager) and `app_is_staff()` (admin, manager, accueil, coach).
--    They compare `app_role()` as text, so no statement of this file
--    uses the new enum labels as values: `ALTER TYPE ... ADD VALUE` and
--    a use of the value cannot share the migration transaction.
--
-- 3. Widened policies, kept under their names so the existing pgTAP
--    files keep covering them:
--      users_read_same_studio               staff (was admin, coach)
--      reservations_read_admin_same_studio  staff (was admin, coach)
--      classes_insert/update/delete_admin   admin or manager
--      reservations_update_admin            admin or manager
--      audit_admin_only                     admin or manager
--      programs_read_staff                  admin, manager, coach
--      programs/program_weeks/program_workouts admin writes: admin or manager
--    `checkin_mark_reservation` admits every staff role.
--    Not widened on purpose: `users_update_admin` (a manager never
--    writes another user's row; role changes go through the functions of
--    section 5), `studios_admin_update_own` (branding), the billing and
--    outbox policies.
--
-- 4. `studio_invitations`: one pending invitation per studio and email,
--    the token kept as a SHA-256 hex digest only. Admins and managers
--    read the studio's invitations (no SELECT on `token_hash` for
--    athlya_app); every write goes through section 5.
--
-- 5. Team functions, admin callers only except the acceptance:
--      team_invite(email, role, token_hash, expires_at)
--      team_set_member_role(user_id, role)   (`member` removes from team)
--      team_revoke_invitation(id)
--      team_accept_invitation(token_hash)    (the invited account itself)
--    Every role change bumps `credentials_version`, so access tokens
--    minted with the previous role can no longer mutate.
--
-- Conventions (0032): functions owned by `athlya_owner`, `SET
-- search_path = public, pg_temp`, EXECUTE revoked from PUBLIC and
-- granted to athlya_app only.
--
-- Expand step: two enum labels, one table, new functions and policies
-- that only admit more callers. An old Worker never sends the new roles,
-- so it runs unchanged against this schema.
-- =====================================================================

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'manager';--> statement-breakpoint
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'accueil';--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Role helpers
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.app_is_manager() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(public.app_role() IN ('admin', 'manager'), false)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.app_is_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(public.app_role() IN ('admin', 'manager', 'accueil', 'coach'), false)
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Widened policies
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS "users_read_same_studio" ON "users";--> statement-breakpoint
CREATE POLICY "users_read_same_studio" ON "users"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_is_staff());
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_insert_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_insert_admin" ON "classes"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_update_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_update_admin" ON "classes"
    FOR UPDATE
    USING (studio_id = public.app_studio_id() AND public.app_is_manager())
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "classes_delete_admin" ON "classes";--> statement-breakpoint
CREATE POLICY "classes_delete_admin" ON "classes"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_read_admin_same_studio" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_read_admin_same_studio" ON "reservations"
    FOR SELECT
    USING (
        public.app_is_staff()
        AND EXISTS (
            SELECT 1
              FROM "classes" c
             WHERE c.id = "reservations".class_id
               AND c.studio_id = public.app_studio_id()
        )
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "reservations_update_admin" ON "reservations";--> statement-breakpoint
CREATE POLICY "reservations_update_admin" ON "reservations"
    FOR UPDATE
    USING (
        public.app_is_manager()
        AND EXISTS (
            SELECT 1
              FROM "classes" c
             WHERE c.id = "reservations".class_id
               AND c.studio_id = public.app_studio_id()
        )
    )
    WITH CHECK (
        public.app_is_manager()
        AND EXISTS (
            SELECT 1
              FROM "classes" c
             WHERE c.id = "reservations".class_id
               AND c.studio_id = public.app_studio_id()
        )
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (public.app_is_manager() AND "studio_id" = public.app_studio_id());
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_read_staff" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_read_staff" ON "programs"
    FOR SELECT
    USING (
        studio_id = public.app_studio_id()
        AND COALESCE(public.app_role() IN ('admin', 'manager', 'coach'), false)
    );
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_admin_insert" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_admin_insert" ON "programs"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "programs_admin_update" ON "programs";--> statement-breakpoint
CREATE POLICY "programs_admin_update" ON "programs"
    FOR UPDATE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_is_manager()
        AND status <> 'archived'
    )
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "program_weeks_admin_insert" ON "program_weeks";--> statement-breakpoint
CREATE POLICY "program_weeks_admin_insert" ON "program_weeks"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "program_weeks_admin_delete" ON "program_weeks";--> statement-breakpoint
CREATE POLICY "program_weeks_admin_delete" ON "program_weeks"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "program_workouts_admin_insert" ON "program_workouts";--> statement-breakpoint
CREATE POLICY "program_workouts_admin_insert" ON "program_workouts"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

DROP POLICY IF EXISTS "program_workouts_admin_delete" ON "program_workouts";--> statement-breakpoint
CREATE POLICY "program_workouts_admin_delete" ON "program_workouts"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

-- Same body as 0045 but the role gate, which now admits every staff role.
CREATE OR REPLACE FUNCTION checkin_mark_reservation(p_reservation_id uuid, p_at timestamptz)
RETURNS TABLE (
    id uuid,
    class_id uuid,
    user_id uuid,
    status reservation_status,
    created_at timestamptz,
    cancelled_at timestamptz,
    checked_in_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.app_is_staff() THEN
        RAISE EXCEPTION 'check-in requires a staff caller'
            USING ERRCODE = '42501';
    END IF;

    IF (SELECT count(*)
          FROM reservations AS done
         WHERE done.user_id = (SELECT target.user_id FROM reservations AS target
                                WHERE target.id = p_reservation_id)
           AND done.checked_in_at > p_at - interval '1 hour'
           AND done.checked_in_at <= p_at) >= 5 THEN
        RAISE EXCEPTION 'checkin_limit_reached' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    UPDATE reservations AS r
       SET checked_in_at = p_at
      FROM classes AS c
     WHERE r.id = p_reservation_id
       AND r.status = 'confirmed'
       AND r.checked_in_at IS NULL
       AND c.id = r.class_id
       AND c.deleted_at IS NULL
       AND c.studio_id = public.app_studio_id()
    RETURNING r.id, r.class_id, r.user_id, r.status, r.created_at, r.cancelled_at, r.checked_in_at;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION checkin_mark_reservation(uuid, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION checkin_mark_reservation(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION checkin_mark_reservation(uuid, timestamptz) TO athlya_app;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Invitations
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "studio_invitations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "studio_id" uuid NOT NULL REFERENCES "studios"("id") ON DELETE CASCADE,
    "email" citext NOT NULL,
    "role" "user_role" NOT NULL,
    "token_hash" text NOT NULL,
    "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "accepted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "studio_invitations_role_staff" CHECK ("role" <> 'member'),
    CONSTRAINT "studio_invitations_token_hash_shape" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "studio_invitations_expiry_after_creation" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "studio_invitations_token_hash_unique"
    ON "studio_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "studio_invitations_pending_unique"
    ON "studio_invitations" USING btree ("studio_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint

ALTER TABLE "studio_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "studio_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "studio_invitations_read_managers" ON "studio_invitations";--> statement-breakpoint
CREATE POLICY "studio_invitations_read_managers" ON "studio_invitations"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_is_manager());
--> statement-breakpoint

-- The default privileges of 0004 grant SELECT on every new table; the
-- token digest is not part of what the application reads.
REVOKE ALL ON "studio_invitations" FROM athlya_app;--> statement-breakpoint
GRANT SELECT ("id", "studio_id", "email", "role", "invited_by", "created_at", "expires_at",
              "accepted_at", "accepted_by", "revoked_at")
    ON "studio_invitations" TO athlya_app;--> statement-breakpoint

GRANT SELECT, INSERT ON "studio_invitations" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("accepted_at", "accepted_by", "revoked_at") ON "studio_invitations" TO athlya_owner;--> statement-breakpoint
GRANT UPDATE ("role") ON "users" TO athlya_owner;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Team functions
-- ---------------------------------------------------------------------

-- Invite `p_email` as `p_role`. A live account of the caller's studio
-- with that email gets the role at once (`role_updated`); otherwise a
-- pending invitation replaces any previous pending one for the email
-- (`invited`). The caller cannot target themselves.
CREATE OR REPLACE FUNCTION team_invite(
    p_email text,
    p_role text,
    p_token_hash text,
    p_expires_at timestamptz
)
RETURNS TABLE (outcome text, user_id uuid, invitation_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_studio uuid := public.app_studio_id();
    v_target uuid;
    v_invitation uuid;
BEGIN
    IF public.app_role() IS DISTINCT FROM 'admin' OR v_studio IS NULL THEN
        RAISE EXCEPTION 'team changes require an admin caller' USING ERRCODE = '42501';
    END IF;
    IF p_role NOT IN ('admin', 'manager', 'accueil', 'coach') THEN
        RAISE EXCEPTION 'invalid_team_role' USING ERRCODE = '22023';
    END IF;
    IF p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
        RAISE EXCEPTION 'invitation_expiry_out_of_range' USING ERRCODE = '22023';
    END IF;

    SELECT u.id INTO v_target
      FROM users u
     WHERE u.studio_id = v_studio
       AND u.email = p_email::citext
       AND u.deleted_at IS NULL;

    IF v_target IS NOT NULL THEN
        IF v_target = public.app_user_id() THEN
            RAISE EXCEPTION 'cannot_change_own_role' USING ERRCODE = 'P0001';
        END IF;
        UPDATE users
           SET role = p_role::user_role,
               credentials_version = credentials_version + 1
         WHERE id = v_target
           AND role IS DISTINCT FROM p_role::user_role;
        RETURN QUERY SELECT 'role_updated'::text, v_target, NULL::uuid;
        RETURN;
    END IF;

    UPDATE studio_invitations
       SET revoked_at = now()
     WHERE studio_id = v_studio
       AND email = p_email::citext
       AND accepted_at IS NULL
       AND revoked_at IS NULL;

    INSERT INTO studio_invitations (studio_id, email, role, token_hash, invited_by, expires_at)
    VALUES (v_studio, p_email::citext, p_role::user_role, p_token_hash, public.app_user_id(), p_expires_at)
    RETURNING id INTO v_invitation;

    RETURN QUERY SELECT 'invited'::text, NULL::uuid, v_invitation;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION team_invite(text, text, text, timestamptz) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_invite(text, text, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_invite(text, text, text, timestamptz) TO athlya_app;--> statement-breakpoint

-- Change the role of a live account of the caller's studio. `member`
-- takes the account off the team. No row when the account is not found.
CREATE OR REPLACE FUNCTION team_set_member_role(p_user_id uuid, p_role text)
RETURNS TABLE (id uuid, role user_role)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.app_role() IS DISTINCT FROM 'admin' OR public.app_studio_id() IS NULL THEN
        RAISE EXCEPTION 'team changes require an admin caller' USING ERRCODE = '42501';
    END IF;
    IF p_role NOT IN ('member', 'admin', 'manager', 'accueil', 'coach') THEN
        RAISE EXCEPTION 'invalid_team_role' USING ERRCODE = '22023';
    END IF;
    IF p_user_id = public.app_user_id() THEN
        RAISE EXCEPTION 'cannot_change_own_role' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    UPDATE users AS u
       SET role = p_role::user_role,
           credentials_version = u.credentials_version
               + CASE WHEN u.role IS DISTINCT FROM p_role::user_role THEN 1 ELSE 0 END
     WHERE u.id = p_user_id
       AND u.studio_id = public.app_studio_id()
       AND u.deleted_at IS NULL
    RETURNING u.id, u.role;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION team_set_member_role(uuid, text) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_set_member_role(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_set_member_role(uuid, text) TO athlya_app;--> statement-breakpoint

-- Revoke a pending invitation of the caller's studio. False when there
-- is none with that id.
CREATE OR REPLACE FUNCTION team_revoke_invitation(p_invitation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.app_role() IS DISTINCT FROM 'admin' OR public.app_studio_id() IS NULL THEN
        RAISE EXCEPTION 'team changes require an admin caller' USING ERRCODE = '42501';
    END IF;

    UPDATE studio_invitations
       SET revoked_at = now()
     WHERE id = p_invitation_id
       AND studio_id = public.app_studio_id()
       AND accepted_at IS NULL
       AND revoked_at IS NULL;
    RETURN FOUND;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION team_revoke_invitation(uuid) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_revoke_invitation(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_revoke_invitation(uuid) TO athlya_app;--> statement-breakpoint

-- Accept the invitation whose token digest is `p_token_hash`, as the
-- signed-in account: it must belong to the invitation's studio, carry
-- the invited email and be live; the invitation must be pending and
-- unexpired. Returns the granted role, or no row when any check fails
-- (one answer for every failure, so a token cannot be probed).
CREATE OR REPLACE FUNCTION team_accept_invitation(p_token_hash text)
RETURNS TABLE (role user_role)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_invitation studio_invitations%ROWTYPE;
    v_user uuid := public.app_user_id();
BEGIN
    IF v_user IS NULL OR public.app_studio_id() IS NULL THEN
        RAISE EXCEPTION 'accepting an invitation requires a signed-in caller' USING ERRCODE = '42501';
    END IF;

    SELECT i.* INTO v_invitation
      FROM studio_invitations i
      JOIN users u
        ON u.id = v_user
       AND u.studio_id = i.studio_id
       AND u.email = i.email
       AND u.deleted_at IS NULL
     WHERE i.token_hash = p_token_hash
       AND i.studio_id = public.app_studio_id()
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
       FOR UPDATE OF i;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    UPDATE studio_invitations
       SET accepted_at = now(), accepted_by = v_user
     WHERE id = v_invitation.id;

    RETURN QUERY
    UPDATE users AS u
       SET role = v_invitation.role,
           credentials_version = u.credentials_version + 1
     WHERE u.id = v_user
    RETURNING u.role;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION team_accept_invitation(text) OWNER TO athlya_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION team_accept_invitation(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION team_accept_invitation(text) TO athlya_app;

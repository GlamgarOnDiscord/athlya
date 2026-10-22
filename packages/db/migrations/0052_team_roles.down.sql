-- Rollback for 0052_team_roles.sql (issue #756).
--
-- Accounts holding a new role go back to `member` first (and their
-- access tokens stop mutating): the code before 0052 rejects any other
-- label. PostgreSQL cannot drop an enum value, so `user_role` keeps
-- `manager` and `accueil`; nothing writes them once this file has run.

UPDATE users
   SET role = 'member',
       credentials_version = credentials_version + 1
 WHERE role::text IN ('manager', 'accueil');

DROP FUNCTION IF EXISTS team_accept_invitation(text);
DROP FUNCTION IF EXISTS team_revoke_invitation(uuid);
DROP FUNCTION IF EXISTS team_set_member_role(uuid, text);
DROP FUNCTION IF EXISTS team_invite(text, text, text, timestamptz);

REVOKE UPDATE ("role") ON "users" FROM athlya_owner;
DROP TABLE IF EXISTS "studio_invitations";

-- 0045 check-in gate: admin or coach.
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
    IF public.app_role() IS DISTINCT FROM 'admin'
       AND public.app_role() IS DISTINCT FROM 'coach' THEN
        RAISE EXCEPTION 'check-in requires an admin or coach caller'
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

-- Policies as 0001, 0023 and 0042 left them.
DROP POLICY IF EXISTS "users_read_same_studio" ON "users";
CREATE POLICY "users_read_same_studio" ON "users"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS "classes_insert_admin" ON "classes";
CREATE POLICY "classes_insert_admin" ON "classes"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "classes_update_admin" ON "classes";
CREATE POLICY "classes_update_admin" ON "classes"
    FOR UPDATE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin')
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "classes_delete_admin" ON "classes";
CREATE POLICY "classes_delete_admin" ON "classes"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "reservations_read_admin_same_studio" ON "reservations";
CREATE POLICY "reservations_read_admin_same_studio" ON "reservations"
    FOR SELECT
    USING (
        public.app_role() IN ('admin', 'coach')
        AND EXISTS (
            SELECT 1 FROM "classes" c
             WHERE c.id = "reservations".class_id AND c.studio_id = public.app_studio_id()
        )
    );

DROP POLICY IF EXISTS "reservations_update_admin" ON "reservations";
CREATE POLICY "reservations_update_admin" ON "reservations"
    FOR UPDATE
    USING (
        public.app_role() = 'admin'
        AND EXISTS (
            SELECT 1 FROM "classes" c
             WHERE c.id = "reservations".class_id AND c.studio_id = public.app_studio_id()
        )
    )
    WITH CHECK (
        public.app_role() = 'admin'
        AND EXISTS (
            SELECT 1 FROM "classes" c
             WHERE c.id = "reservations".class_id AND c.studio_id = public.app_studio_id()
        )
    );

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (public.app_role() = 'admin' AND "studio_id" = public.app_studio_id());

DROP POLICY IF EXISTS "programs_read_staff" ON "programs";
CREATE POLICY "programs_read_staff" ON "programs"
    FOR SELECT
    USING (studio_id = public.app_studio_id() AND public.app_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS "programs_admin_insert" ON "programs";
CREATE POLICY "programs_admin_insert" ON "programs"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "programs_admin_update" ON "programs";
CREATE POLICY "programs_admin_update" ON "programs"
    FOR UPDATE
    USING (
        studio_id = public.app_studio_id()
        AND public.app_role() = 'admin'
        AND status <> 'archived'
    )
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "program_weeks_admin_insert" ON "program_weeks";
CREATE POLICY "program_weeks_admin_insert" ON "program_weeks"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "program_weeks_admin_delete" ON "program_weeks";
CREATE POLICY "program_weeks_admin_delete" ON "program_weeks"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "program_workouts_admin_insert" ON "program_workouts";
CREATE POLICY "program_workouts_admin_insert" ON "program_workouts"
    FOR INSERT
    WITH CHECK (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP POLICY IF EXISTS "program_workouts_admin_delete" ON "program_workouts";
CREATE POLICY "program_workouts_admin_delete" ON "program_workouts"
    FOR DELETE
    USING (studio_id = public.app_studio_id() AND public.app_role() = 'admin');

DROP FUNCTION IF EXISTS public.app_is_staff();
DROP FUNCTION IF EXISTS public.app_is_manager();

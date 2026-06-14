-- Revert 0017: restore unpartitioned audit_log with bigserial primary key.

-- 1. Create unpartitioned replacement table.
CREATE TABLE "_audit_log_new" (
    "id"          bigserial       PRIMARY KEY,
    "actor_id"    uuid,
    "action"      text            NOT NULL,
    "target_type" text,
    "target_id"   text,
    "metadata"    jsonb           NOT NULL DEFAULT '{}'::jsonb,
    "studio_id"   uuid            DEFAULT (NULLIF(current_setting('app.studio_id', true), '')::uuid),
    "created_at"  timestamptz     NOT NULL DEFAULT now()
);

-- 2. Set sequence high-water mark to avoid id collisions.
SELECT setval(
    pg_get_serial_sequence('"_audit_log_new"', 'id'),
    COALESCE((SELECT MAX(id) FROM "audit_log"), 1)
);

-- 3. Copy all rows from partitioned table.
INSERT INTO "_audit_log_new"
    ("id", "actor_id", "action", "target_type", "target_id",
     "metadata", "studio_id", "created_at")
SELECT "id", "actor_id", "action", "target_type", "target_id",
       "metadata", "studio_id", "created_at"
FROM "audit_log";

-- 4. Drop partitioned table (and all partitions + ensure_next helper).
DROP TABLE "audit_log";
DROP FUNCTION IF EXISTS ensure_next_audit_log_partition(timestamptz);
REVOKE CREATE ON SCHEMA public FROM athlya_owner;

-- 5. Rename replacement into place.
ALTER TABLE "_audit_log_new" RENAME TO "audit_log";

-- 6. Restore ownership, FK, RLS, grants, triggers.
ALTER TABLE "audit_log" OWNER TO athlya_owner;

ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND (
            "studio_id" IS NULL
            OR "studio_id" = public.app_studio_id()
        )
    );

DROP POLICY IF EXISTS "audit_app_insert" ON "audit_log";
CREATE POLICY "audit_app_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS "audit_no_update" ON "audit_log";
CREATE POLICY "audit_no_update" ON "audit_log"
    FOR UPDATE
    USING (FALSE);

DROP POLICY IF EXISTS "audit_no_delete" ON "audit_log";
CREATE POLICY "audit_no_delete" ON "audit_log"
    FOR DELETE
    USING (FALSE);

REVOKE ALL ON "audit_log" FROM PUBLIC;
REVOKE ALL ON "audit_log" FROM athlya_app;
REVOKE ALL ON "audit_log" FROM athlya_cron;

GRANT SELECT, INSERT ON "audit_log" TO athlya_app;
GRANT SELECT, UPDATE ("actor_id", "metadata") ON "audit_log" TO athlya_cron;

DROP TRIGGER IF EXISTS "audit_log_forbid_update" ON "audit_log";
CREATE TRIGGER "audit_log_forbid_update"
    BEFORE UPDATE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS "audit_log_forbid_delete" ON "audit_log";
CREATE TRIGGER "audit_log_forbid_delete"
    BEFORE DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- =====================================================================
-- Athlya Platform — partition audit_log by month (0017, issue #235)
--
-- Converts audit_log from a plain bigserial table to a declarative
-- range-partitioned table (PARTITION BY RANGE (created_at)) so that:
--
--   • Admin date-range queries use partition pruning instead of a full
--     table scan (Req 22.3, admin audit endpoint).
--   • VACUUM and autovacuum operate per-partition, keeping dead-tuple
--     overhead proportional to the active month's write rate.
--   • The J+30 anonymisation UPDATE (`WHERE created_at < now() - '30d'`)
--     touches only the relevant monthly partition(s).
--
-- Design decisions
-- ----------------
-- 1. PRIMARY KEY changes from (id) → (id, created_at). PostgreSQL
--    requires every unique constraint on a partitioned table to include
--    the partition key. audit_log has no inbound FK references (nothing
--    points at audit_log.id), so the change is safe.
--
-- 2. The existing bigserial sequence (audit_log_id_seq) is reused by the
--    new table so id values remain globally unique across partitions.
--    Sequence ownership is transferred to the new table before the old
--    table is dropped.
--
-- 3. Triggers: in PostgreSQL 14+ row-level triggers defined on a
--    partitioned parent are cloned to each partition (existing and
--    future). Neon runs PostgreSQL 17 — no per-partition wiring needed.
--
-- 4. Ownership (athlya_owner), grants (athlya_app, athlya_cron), and
--    RLS policies are restored to the posture established in migrations
--    0003, 0009, 0011, and 0015.
--
-- 5. athlya_owner needs CREATE ON SCHEMA public to create future
--    partition tables from the SECURITY DEFINER maintenance function.
--
-- 6. ensure_next_audit_log_partition(timestamptz) creates next month's
--    partition when it does not yet exist. Called monthly by the cron
--    maintenance runner; idempotent so calling it more often is safe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Rename existing table.
--    The bigserial sequence keeps its name (audit_log_id_seq); its
--    owned-by reference moves to _audit_log_legacy.id automatically.
-- ---------------------------------------------------------------------
ALTER TABLE "audit_log" RENAME TO "_audit_log_legacy";--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 2. Create partitioned parent.
-- ---------------------------------------------------------------------
CREATE TABLE "audit_log" (
    "id"          bigint          NOT NULL DEFAULT nextval('audit_log_id_seq'::regclass),
    "actor_id"    uuid,
    "action"      text            NOT NULL,
    "target_type" text,
    "target_id"   text,
    "metadata"    jsonb           NOT NULL DEFAULT '{}'::jsonb,
    "studio_id"   uuid            DEFAULT (NULLIF(current_setting('app.studio_id', true), '')::uuid),
    "created_at"  timestamptz     NOT NULL DEFAULT now(),
    PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint

-- Transfer sequence ownership so the sequence survives the DROP below.
ALTER SEQUENCE "audit_log_id_seq" OWNED BY "audit_log"."id";--> statement-breakpoint

-- Ownership must be set before partition creation (partitions inherit it).
ALTER TABLE "audit_log" OWNER TO athlya_owner;--> statement-breakpoint

-- FK on new partitioned parent (same semantics as original).
ALTER TABLE "audit_log"
    ADD CONSTRAINT "audit_log_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- Secondary indexes for common query patterns.
CREATE INDEX "audit_log_actor_id_idx"
    ON "audit_log" ("actor_id") WHERE "actor_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "audit_log_studio_created_idx"
    ON "audit_log" ("studio_id", "created_at") WHERE "studio_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 3. Create partitions.
--    audit_log_pre      — all rows before 2026-06 (MINVALUE)
--    audit_log_YYYY_MM  — one per calendar month, 13 months ahead
-- ---------------------------------------------------------------------
CREATE TABLE "audit_log_pre" PARTITION OF "audit_log"
    FOR VALUES FROM (MINVALUE) TO ('2026-06-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_06" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_07" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_08" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_09" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_10" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_11" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2026_12" PARTITION OF "audit_log"
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2027_01" PARTITION OF "audit_log"
    FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2027_02" PARTITION OF "audit_log"
    FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2027_03" PARTITION OF "audit_log"
    FOR VALUES FROM ('2027-03-01 00:00:00+00') TO ('2027-04-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2027_04" PARTITION OF "audit_log"
    FOR VALUES FROM ('2027-04-01 00:00:00+00') TO ('2027-05-01 00:00:00+00');--> statement-breakpoint

CREATE TABLE "audit_log_2027_05" PARTITION OF "audit_log"
    FOR VALUES FROM ('2027-05-01 00:00:00+00') TO ('2027-06-01 00:00:00+00');--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 4. Copy historical data.
-- ---------------------------------------------------------------------
INSERT INTO "audit_log"
    ("id", "actor_id", "action", "target_type", "target_id",
     "metadata", "studio_id", "created_at")
SELECT "id", "actor_id", "action", "target_type", "target_id",
       "metadata", "studio_id", "created_at"
FROM "_audit_log_legacy";--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 5. Restore RLS (posture from 0001 + 0003 + 0011 + 0015).
-- ---------------------------------------------------------------------
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "audit_admin_only" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_admin_only" ON "audit_log"
    FOR SELECT
    USING (
        public.app_role() = 'admin'
        AND (
            "studio_id" IS NULL
            OR "studio_id" = public.app_studio_id()
        )
    );--> statement-breakpoint

DROP POLICY IF EXISTS "audit_app_insert" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_app_insert" ON "audit_log"
    FOR INSERT
    WITH CHECK (TRUE);--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_update" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_update" ON "audit_log"
    FOR UPDATE
    USING (FALSE);--> statement-breakpoint

DROP POLICY IF EXISTS "audit_no_delete" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_no_delete" ON "audit_log"
    FOR DELETE
    USING (FALSE);--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 6. Grants (posture from 0003 + 0009 + 0012).
-- ---------------------------------------------------------------------
REVOKE ALL ON "audit_log" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON "audit_log" FROM athlya_app;--> statement-breakpoint
REVOKE ALL ON "audit_log" FROM athlya_cron;--> statement-breakpoint

GRANT SELECT, INSERT ON "audit_log" TO athlya_app;--> statement-breakpoint
GRANT SELECT, UPDATE ("actor_id", "metadata") ON "audit_log" TO athlya_cron;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 7. Restore immutability triggers.
--    audit_log_immutable() already exists (migration 0003). In PG 14+,
--    row-level triggers on a partitioned parent are cloned to all
--    existing and future partitions automatically.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS "audit_log_forbid_update" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_forbid_update"
    BEFORE UPDATE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint

DROP TRIGGER IF EXISTS "audit_log_forbid_delete" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_forbid_delete"
    BEFORE DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 8. Auto-partition helper.
--
--    Creates next month's partition when it does not yet exist.
--    Called from the maintenance cron (audit-partition-runner.ts).
--    Idempotent; safe to call more than once per month.
--
--    Runs SECURITY DEFINER as athlya_owner, which owns audit_log and
--    can therefore create partition tables. Requires CREATE ON SCHEMA
--    public granted below.
-- ---------------------------------------------------------------------
GRANT CREATE ON SCHEMA public TO athlya_owner;--> statement-breakpoint

CREATE OR REPLACE FUNCTION ensure_next_audit_log_partition(
    p_date timestamptz DEFAULT now()
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_next_start  date := date_trunc('month', p_date + interval '1 month')::date;
    v_next_end    date := date_trunc('month', p_date + interval '2 months')::date;
    v_name        text := 'audit_log_' || to_char(v_next_start, 'YYYY_MM');
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = v_name
    ) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_log'
            ' FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
            v_name,
            v_next_start::timestamptz,
            v_next_end::timestamptz
        );
        RETURN 'created: ' || v_name;
    END IF;
    RETURN 'exists: ' || v_name;
END;
$$;--> statement-breakpoint

ALTER FUNCTION ensure_next_audit_log_partition(timestamptz) OWNER TO athlya_owner;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION ensure_next_audit_log_partition(timestamptz) TO athlya_cron;--> statement-breakpoint

-- ---------------------------------------------------------------------
-- 9. Drop legacy table. Sequence is now owned by audit_log.id and is
--    not dropped with the table.
-- ---------------------------------------------------------------------
DROP TABLE "_audit_log_legacy";

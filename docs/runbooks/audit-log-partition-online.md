# Runbook: Online Audit Log Table Partitioning

> Issue #416. Migration 0017 ships with an `INSERT INTO ... SELECT` bulk copy
> that is safe on an empty or tiny table but blocks audit writes and generates
> large WAL on a populated table. Use this runbook once the table exceeds
> ~1 M rows or if the migration must run with zero downtime.

## Background

Migration 0017 converts `audit_log` from a plain table to a range-partitioned
table via the following sequence:

1. `ALTER TABLE audit_log RENAME TO _audit_log_legacy` (brief ACCESS EXCLUSIVE)
2. `CREATE TABLE audit_log PARTITION BY RANGE (created_at)` (new, empty)
3. `INSERT INTO audit_log SELECT * FROM _audit_log_legacy` (full table copy)
4. Restore RLS, grants, triggers
5. `DROP TABLE _audit_log_legacy`

Step 3 holds an ACCESS EXCLUSIVE lock on the **new** table and generates WAL
proportional to the audit row count. On a small table this completes in under
a second; on millions of rows it can lock audit writes for minutes and cause
replication lag on Neon.

---

## Online Expand/Contract Plan

### Phase 0 — Pre-conditions

```sql
-- Measure the table first.
SELECT
    pg_size_pretty(pg_total_relation_size('audit_log')) AS total_size,
    count(*) AS row_count
FROM audit_log;
```

If `row_count < 100 000`, the standard migration is fine. Skip this runbook.

### Phase 1 — Expand: create shadow partitioned table

```sql
-- Do NOT touch audit_log. Create the partitioned target alongside it.
CREATE TABLE audit_log_partitioned (
    LIKE audit_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (created_at);

-- Create the same partitions as in 0017 plus any new months.
CREATE TABLE audit_log_pre PARTITION OF audit_log_partitioned
    FOR VALUES FROM (MINVALUE) TO ('2026-06-01 00:00:00+00');

CREATE TABLE audit_log_2026_06 PARTITION OF audit_log_partitioned
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
-- … repeat for each month partition …

-- Re-create the secondary indexes.
CREATE INDEX CONCURRENTLY audit_log_p_actor_id_idx
    ON audit_log_partitioned (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX CONCURRENTLY audit_log_p_studio_created_idx
    ON audit_log_partitioned (studio_id, created_at) WHERE studio_id IS NOT NULL;
```

### Phase 2 — Dual-write trigger

Install a trigger on the **old** table so every new insert is mirrored into
the new table. This keeps the shadow current while the batched backfill runs.

```sql
CREATE OR REPLACE FUNCTION audit_log_mirror_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO audit_log_partitioned
        (id, actor_id, action, target_type, target_id, metadata, studio_id, created_at)
    VALUES
        (NEW.id, NEW.actor_id, NEW.action, NEW.target_type, NEW.target_id,
         NEW.metadata, NEW.studio_id, NEW.created_at)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_mirror
    AFTER INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_mirror_insert();
```

> **Note**: The trigger runs inside the caller's transaction. If it fails,
> the original write also rolls back. Keep the trigger body minimal.

### Phase 3 — Batched backfill

Run from a maintenance script outside application traffic hours. Use keyset
pagination so each batch holds a minimal lock window.

```sql
DO $$
DECLARE
    v_cursor bigint := 0;
    v_batch  int    := 5000;
    v_count  int;
BEGIN
    LOOP
        INSERT INTO audit_log_partitioned
            (id, actor_id, action, target_type, target_id, metadata, studio_id, created_at)
        SELECT id, actor_id, action, target_type, target_id, metadata, studio_id, created_at
        FROM   audit_log
        WHERE  id > v_cursor
        ORDER  BY id
        LIMIT  v_batch
        ON CONFLICT DO NOTHING;

        GET DIAGNOSTICS v_count = ROW_COUNT;
        EXIT WHEN v_count < v_batch;

        SELECT max(id) INTO v_cursor
        FROM   audit_log
        WHERE  id > v_cursor
        ORDER  BY id
        LIMIT  v_batch;

        PERFORM pg_sleep(0.1);  -- back-pressure: 100 ms between batches
    END LOOP;
END;
$$;
```

### Phase 4 — Validate

Before cutover, verify row counts match.

```sql
SELECT
    (SELECT count(*) FROM audit_log)             AS legacy_count,
    (SELECT count(*) FROM audit_log_partitioned) AS shadow_count;
```

Both counts should be equal. If `shadow_count < legacy_count`, the backfill is
incomplete or the trigger dropped rows — investigate before proceeding.

### Phase 5 — Short cutover (ACCESS EXCLUSIVE, < 1 s on empty legacy)

```sql
BEGIN;

-- Drop the mirror trigger (no longer needed after cutover).
DROP TRIGGER audit_log_mirror ON audit_log;
DROP FUNCTION audit_log_mirror_insert();

-- Rename tables atomically.
ALTER TABLE audit_log RENAME TO _audit_log_legacy_v2;
ALTER TABLE audit_log_partitioned RENAME TO audit_log;

-- Restore RLS + grants + triggers on the renamed table.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Re-apply the policies from migration 0023.
DROP POLICY IF EXISTS "audit_admin_only" ON audit_log;
CREATE POLICY "audit_admin_only" ON audit_log
    FOR SELECT
    USING (app_role() = 'admin' AND studio_id = app_studio_id());

DROP POLICY IF EXISTS "audit_app_insert" ON audit_log;
CREATE POLICY "audit_app_insert" ON audit_log FOR INSERT WITH CHECK (TRUE);

DROP POLICY IF EXISTS "audit_no_update" ON audit_log;
CREATE POLICY "audit_no_update" ON audit_log FOR UPDATE USING (FALSE);

DROP POLICY IF EXISTS "audit_no_delete" ON audit_log;
CREATE POLICY "audit_no_delete" ON audit_log FOR DELETE USING (FALSE);

-- Grants.
REVOKE ALL ON audit_log FROM PUBLIC;
REVOKE ALL ON audit_log FROM athlya_app;
GRANT SELECT, INSERT ON audit_log TO athlya_app;

-- Triggers.
CREATE TRIGGER audit_log_forbid_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_forbid_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

COMMIT;
```

### Phase 6 — Cleanup (separate deploy, days later)

Once confident the cutover is stable:

```sql
DROP TABLE _audit_log_legacy_v2;
```

---

## Rollback

If cutover fails or the new table misbehaves:

```sql
BEGIN;
-- Tear down the new table name.
ALTER TABLE audit_log RENAME TO audit_log_partitioned;
-- Restore old name.
ALTER TABLE _audit_log_legacy_v2 RENAME TO audit_log;
-- Re-install the mirror trigger if writes happened after cutover.
-- (See Phase 2 above.)
COMMIT;
```

---

## Lock Duration Estimate

| Step                                  | Lock type                                           | Typical duration           |
| ------------------------------------- | --------------------------------------------------- | -------------------------- |
| Phase 1: `CREATE TABLE` shadow        | None on `audit_log`                                 | < 10 ms                    |
| Phase 2: `CREATE TRIGGER`             | SHARE ROW EXCLUSIVE on `audit_log`                  | < 5 ms                     |
| Phase 3: batched backfill             | None (keyset SELECT, ON CONFLICT DO NOTHING INSERT) | Minutes–hours, no blocking |
| Phase 4: count validation             | None                                                | Seconds                    |
| Phase 5: cutover `ALTER TABLE RENAME` | ACCESS EXCLUSIVE (2 × rename)                       | < 50 ms each               |
| Phase 6: `DROP TABLE _legacy`         | ACCESS EXCLUSIVE on legacy only                     | < 100 ms                   |

The longest write-blocking window is the two `RENAME` statements in Phase 5 —
under 50 ms each against an empty legacy table. Against a live system, queue
this during a low-traffic window.

---

## References

- `packages/db/migrations/0017_audit_log_partition.sql`
- `docs/runbooks/expand-contract-migrations.md`
- Neon docs: logical replication and online DDL

# Runbook: Expand/Contract Migrations

> Required for any schema change shipped alongside a canary deploy.

## Why

Athlya uses a canary rollout (CN.7.1): the old Worker version handles 1-25%
of traffic while the new version ramps up. Both versions query the same
database. A breaking migration applied before 100% cutover causes the old
Worker to fail on every INSERT/UPDATE that touches the changed schema.

## The Pattern

### Phase 1 — Expand (non-breaking)

Add the new column, index, or table without constraints that would break
existing code:

```sql
-- Good: nullable column, old Workers ignore it
ALTER TABLE reservations ADD COLUMN cancelled_reason text;

-- Good: new index, transparent to all Workers
CREATE INDEX CONCURRENTLY reservations_user_id_created_at_idx
  ON reservations (user_id, created_at DESC) WHERE deleted_at IS NULL;
```

Deploy the migration. Deploy the new Worker (it can now read/write the new
column). Let the canary complete.

### Phase 2 — Contract (breaking, separate deploy)

Once 100% of traffic is on the new Worker and the old version is gone:

```sql
-- athlya:contract
-- Now safe: add NOT NULL, rename, or drop the old column
ALTER TABLE reservations ALTER COLUMN cancelled_reason SET NOT NULL;
ALTER TABLE reservations DROP COLUMN legacy_field;
```

Start every contract migration with a `-- athlya:contract` line. The
automatic SLO rollback (`slo-rollback.yml`, CN.7.3) refuses to roll the
Workers back across a release that ships one: the previous Worker version
would run against a schema it no longer matches. See
[automatic-rollback.md](./automatic-rollback.md).

## Anti-patterns

```sql
-- NEVER: breaks old Workers that don't send cancelled_reason
ALTER TABLE reservations ADD COLUMN cancelled_reason text NOT NULL;

-- NEVER: drops a column the old Worker still reads
ALTER TABLE reservations DROP COLUMN status;
```

## Checklist

Before merging a migration with a Worker deploy:

- [ ] Does the migration add `NOT NULL` without a `DEFAULT`? → Split into expand/contract.
- [ ] Does the migration `DROP COLUMN` or rename a column the current Worker uses? → Split.
- [ ] Does the migration change a column type incompatibly? → Split.
- [ ] Is the migration purely additive (new nullable column, new index, new table)? → Safe to ship together.
- [ ] Is it a contract step? → First line `-- athlya:contract` (blocks the automatic SLO rollback across it).

## References

- Issue #321 — expand/contract enforcement
- CN.7.1 — canary deploy strategy
- `deploy-production.yml` — canary phases

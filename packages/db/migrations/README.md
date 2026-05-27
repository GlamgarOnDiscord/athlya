# Athlya database migrations

This folder is owned by `drizzle-kit`. Every `.sql` file is applied in
lexicographic order by the migrator; the companion `meta/` folder stores
Drizzle's snapshot state and must be committed alongside the SQL.

## Run order

| Order | File                                      | Purpose                                                                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `0000_init.sql`                           | Enables `pgcrypto` + `citext`, creates every enum, table, foreign key and index, converts `users.email` to `citext`, installs the `audit_log_immutable()` trigger that blocks UPDATE / DELETE on `audit_log`. Matches Requirement 22.2.                                                                      |
| 2     | `0001_rls.sql`                            | Enables Row-Level Security on every tenant-scoped table and creates the tenant / role-scoped policies. Matches Requirements 13.2, 13.3, 13.4, 13.6, 22.3 (task 2.3).                                                                                                                                         |
| 3     | `0002_export_jobs.sql`                    | Adds the `export_jobs` table for RGPD exports (task 5.3, Req 4.1–4.4) with its own RLS policy.                                                                                                                                                                                                               |
| 4     | `0003_audit_anonymization.sql`            | RGPD J+30 audit anonymization — creates `athlya_owner` / `athlya_cron` / `athlya_app` (NOLOGIN), the SECURITY DEFINER `anonymize_user_audit(uuid)` function, and rewrites the audit trigger to allow that one path (Req 5.3, 22.2).                                                                          |
| 5     | `0004_rls_hardening.sql`                  | Elevates `athlya_app` to LOGIN + grants application DML on every tenant-scoped table; restates `FORCE ROW LEVEL SECURITY` for self-containment (slice B2, Req 13.6, H1). The role password is provisioned **out of band** by the operator; the runbook lives in `docs/runbooks/db-role-switch.md`.           |
| 6     | `0005_password_reset_audit_anonymize.sql` | Adds the `password_reset_tokens` table (Sprint 7 SP7.2 / S2-006) and the `users.audit_anonymized_at` watermark column read by the J+30 cron driver (Sprint 6 SP6.2 / S5-003). Both changes are additive, safe to apply against a live database.                                                              |
| 7     | `0006_anonymize_audit_scalar_guard.sql`   | Wraps the JSONB minus and `?` operators inside `anonymize_user_audit(uuid)` with `jsonb_typeof(metadata) = 'object'` guards. Closes a latent SQLSTATE 22023 ("cannot delete from scalar") bomb that would crash the J+30 cron the moment any row drifts to a non-object metadata shape (Req 5.3 robustness). |
| 8     | `0007_classes_fts.sql`                    | Adds `description` + `search_vector` GIN index for class search.                                                                                                                                                                                                                                             |
| 9     | `0008_capacity_guard.sql`                 | `BEFORE INSERT OR UPDATE` trigger enforcing `count(confirmed) <= classes.capacity` (Req 8.3 defence-in-depth).                                                                                                                                                                                               |
| 10    | `0009_audit_cron_grants.sql`              | `athlya_cron` LOGIN + DML grants for RGPD cron (`users`, `outbox`, `export_jobs`, `audit_log`). Password via runbook Phase 8.                                                                                                                                                                                |

New schema-shape migrations must be generated via `pnpm --filter
@athlya/db exec drizzle-kit generate --name <descriptive-name>` from the
workspace root. Never hand-author the `CREATE TABLE` section — let the
tool diff the schema and emit the SQL, then hand-augment for PostgreSQL
features Drizzle does not cover (triggers, extensions, RLS policies,
custom types like `citext`).

`0001_rls.sql` is hand-authored because `drizzle-orm` does not yet
expose a first-class RLS builder. The matching `meta/0001_snapshot.json`
is a copy of `0000_snapshot.json` with a fresh `id` and `prevId` chained
to the init snapshot so `drizzle-kit check` stays happy — the table
shape is unchanged.

## Local application

The migrations can be applied against a local Postgres 17 instance with:

```sh
DATABASE_URL=postgres://... pnpm --filter @athlya/db exec drizzle-kit migrate
```

Task 2.2 deliberately does NOT run the migration automatically — it only
generates and validates the SQL file. Application happens later (task
2.3 once RLS policies are in place, and the Neon deployment pipeline in
Epic 18 for staging / production).

## Rollback procedure

Each forward migration has a matching `.down.sql` that reverses its
statements in FK-safe order. To roll back the last `N` migrations,
apply the `.down.sql` files in **reverse** numeric order (latest first):

```sh
psql $DATABASE_URL -f packages/db/migrations/0004_rls_hardening.down.sql
psql $DATABASE_URL -f packages/db/migrations/0003_audit_anonymization.down.sql
psql $DATABASE_URL -f packages/db/migrations/0002_export_jobs.down.sql
psql $DATABASE_URL -f packages/db/migrations/0001_rls.down.sql
psql $DATABASE_URL -f packages/db/migrations/0000_init.down.sql
```

Rollbacks are **idempotent** — every `DROP` uses `IF EXISTS` and every
`ALTER TABLE ... DISABLE ROW LEVEL SECURITY` is a no-op on a
RLS-already-disabled table — so running the same `.down.sql` twice is
safe.

Rollbacks deliberately do **NOT** drop PostgreSQL extensions
(`pgcrypto`, `citext`). Extensions live at the cluster level and may
be used by other databases on the same Neon project or local
cluster; dropping them here would leak blast-radius beyond Athlya.
Re-applying `0000_init.sql` is idempotent on extensions
(`CREATE EXTENSION IF NOT EXISTS`), so leaving them in place is both
safe and reversible.

Rollbacks are **NOT** automatically discovered by `drizzle-kit push`
or `drizzle-kit migrate` — the Drizzle migrator scans `*.sql` in
filename order and has no concept of reversing history. Apply them
manually via `psql` during an incident. The CI `pgtap.yml` workflow
explicitly filters `*.down.sql` out of its forward-apply loop
(`ls … | grep -v '\.down\.sql$' | sort`) so a byte-wise sort can't
accidentally pull a rollback in front of its forward counterpart.

`0001_rls.down.sql` drops every policy before disabling RLS on each
table; `0000_init.down.sql` drops child tables before parents
(`push_tokens` / `idempotency_keys` / … → `users` → `studios`) and
drops the `audit_log_*` triggers before their shared function. Reading
each `.down.sql` alongside its forward counterpart should show a clean
mirror-image of creation order.

## Schema conventions

- UUID primary keys default to `gen_random_uuid()` (UUID v4 via
  `pgcrypto`). When Neon ships `pg_uuidv7`, a follow-up migration will
  swap each default to `uuid_generate_v7()` and flip
  `DEFAULT_UUID_SQL` in `packages/db/src/schema/_shared.ts`. A `TODO`
  marker at the top of `0000_init.sql` tracks this.
- Emails live in `citext` so `UNIQUE(email)` is case-insensitive by
  construction; the application still lower-cases on ingest.
- Soft-deleted tables expose a nullable `deleted_at timestamptz`
  column; default queries should filter `deleted_at IS NULL` via the
  repository layer.
- `audit_log` is strictly append-only. The trigger installed by
  `0000_init.sql` raises on UPDATE or DELETE regardless of role. RLS
  policies in `0001_rls.sql` add a second line of defence for
  application roles that cannot bypass policies.

## Row-Level Security (0001_rls.sql)

### Session variables

The tenant middleware (`withTenant` in `packages/db/src/client.ts`)
opens a transaction on every authenticated request and executes:

```sql
SET LOCAL app.user_id   = '<uuid>';
SET LOCAL app.studio_id = '<uuid>';
SET LOCAL app.role      = '<member|coach|admin>';
```

Policies never read these GUCs directly. They go through the SQL
helpers `public.app_user_id()`, `public.app_studio_id()` and
`public.app_role()` defined at the top of `0001_rls.sql`, which use the
`current_setting(name, missing_ok => true)` form and coerce empty
strings to `NULL`. That keeps the policies fail-closed: an unscoped
connection (CI linter, drizzle-kit push) sees zero rows rather than
raising `unrecognized configuration parameter` or leaking data.

### RLS is forced for the table owner

Every `ENABLE ROW LEVEL SECURITY` is paired with `FORCE ROW LEVEL
SECURITY` so the table owner (the role running migrations) is subject
to the policies too. Without `FORCE`, owner-role queries would bypass
RLS and hide bugs until the first non-owner query in production. Roles
that legitimately need to bypass policies (outbox drain worker, RGPD
cascade job, audit writer) run under a dedicated `BYPASSRLS` service
role provisioned out of band by the deployment pipeline.

### Policy catalogue

| Table              | Policy                                | Command | Predicate (summarised)                                                                                      | Requirement |
| ------------------ | ------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| `studios`          | `studios_read_own_tenant`             | SELECT  | `id = app_studio_id()`                                                                                      | 13.6        |
| `users`            | `users_read_own`                      | SELECT  | `id = app_user_id()`                                                                                        | 13.2        |
| `users`            | `users_read_same_studio`              | SELECT  | `studio_id = app_studio_id() AND app_role() IN ('admin','coach')`                                           | 13.2        |
| `users`            | `users_update_own`                    | UPDATE  | `id = app_user_id()` (USING + WITH CHECK)                                                                   | 3.x, 13.2   |
| `users`            | `users_update_admin`                  | UPDATE  | `studio_id = app_studio_id() AND app_role() = 'admin'`                                                      | 13.2        |
| `classes`          | `classes_read_same_studio`            | SELECT  | `studio_id = app_studio_id()`                                                                               | 13.6        |
| `classes`          | `classes_insert_admin`                | INSERT  | `studio_id = app_studio_id() AND app_role() = 'admin'`                                                      | 6.x, 13.6   |
| `classes`          | `classes_update_admin`                | UPDATE  | `studio_id = app_studio_id() AND app_role() = 'admin'`                                                      | 6.5, 13.6   |
| `classes`          | `classes_delete_admin`                | DELETE  | `studio_id = app_studio_id() AND app_role() = 'admin'`                                                      | 13.6        |
| `reservations`     | `reservations_read_own`               | SELECT  | `user_id = app_user_id()`                                                                                   | 13.3        |
| `reservations`     | `reservations_read_admin_same_studio` | SELECT  | `app_role() IN ('admin','coach') AND EXISTS(classes.id = class_id AND classes.studio_id = app_studio_id())` | 13.3, 13.6  |
| `reservations`     | `reservations_insert_own`             | INSERT  | `user_id = app_user_id()`                                                                                   | 8.x, 13.3   |
| `reservations`     | `reservations_update_own`             | UPDATE  | `user_id = app_user_id()` (USING + WITH CHECK)                                                              | 9.x, 13.3   |
| `reservations`     | `reservations_update_admin`           | UPDATE  | `app_role() = 'admin' AND same-studio join on classes`                                                      | 9.x, 13.6   |
| `workout_sessions` | `workout_sessions_read_own`           | SELECT  | `user_id = app_user_id()`                                                                                   | 13.3        |
| `workout_sessions` | `workout_sessions_insert_own`         | INSERT  | `user_id = app_user_id()`                                                                                   | 12.x        |
| `workout_sessions` | `workout_sessions_update_own`         | UPDATE  | `user_id = app_user_id()` (USING + WITH CHECK)                                                              | 12.x        |
| `workout_sessions` | `workout_sessions_delete_own`         | DELETE  | `user_id = app_user_id()`                                                                                   | 5.x, 12.x   |
| `audit_log`        | `audit_admin_only`                    | SELECT  | `app_role() = 'admin'`                                                                                      | 13.4, 22.3  |
| `audit_log`        | `audit_no_insert`                     | INSERT  | `false` (writes go through BYPASSRLS service role)                                                          | 22.2        |
| `audit_log`        | `audit_no_update`                     | UPDATE  | `false` (belt-and-braces around the trigger)                                                                | 22.2        |
| `audit_log`        | `audit_no_delete`                     | DELETE  | `false` (belt-and-braces around the trigger)                                                                | 22.2        |
| `outbox`           | `outbox_admin_only`                   | SELECT  | `app_role() = 'admin'`                                                                                      | 16.x, 22.3  |
| `idempotency_keys` | `idempotency_keys_read_own`           | SELECT  | `user_id = app_user_id()`                                                                                   | 20.x        |
| `idempotency_keys` | `idempotency_keys_insert_own`         | INSERT  | `user_id = app_user_id()`                                                                                   | 20.x        |
| `idempotency_keys` | `idempotency_keys_delete_own`         | DELETE  | `user_id = app_user_id()`                                                                                   | 20.x        |
| `push_tokens`      | `push_tokens_read_own`                | SELECT  | `user_id = app_user_id()`                                                                                   | 17.x        |
| `push_tokens`      | `push_tokens_insert_own`              | INSERT  | `user_id = app_user_id()`                                                                                   | 17.x        |
| `push_tokens`      | `push_tokens_delete_own`              | DELETE  | `user_id = app_user_id()`                                                                                   | 5.x, 17.x   |

### Deliberate omissions

- No `FOR INSERT` / `FOR DELETE` policy on `users`: registration and
  RGPD hard-deletion go through the Auth service under a BYPASSRLS
  role. Soft-delete (`deleted_at`) is covered by `users_update_own`
  (self-deletion) and `users_update_admin`.
- No `FOR INSERT / UPDATE / DELETE` policy on `outbox`: the drain
  worker runs under a service role. The one tenant-visible operation
  is admin inspection of pending rows via `outbox_admin_only`.
- `studios` has no write policy at the tenant level: new studios are
  provisioned by platform admins out of band (back-office flow),
  again under a service role.

### audit_log scoping (Req 22.3)

Requirement 22.3 asks for admin reads scoped to the admin's own
studio. The `audit_log` table stores `actor_id` (nullable after
anonymization) but no denormalised `studio_id`. The RLS policy
installed here enforces "admin only" (`app_role() = 'admin'`); the
API's audit query helper adds the studio join
(`JOIN users ON audit_log.actor_id = users.id WHERE users.studio_id =
$studio_id`) when serving `/v1/admin/audit`. A follow-up migration
tracked by the `TODO(req-22.3)` comment in `0001_rls.sql` will add a
denormalised `studio_id` column to `audit_log` and tighten the policy
once the admin UI is specced in Epic 11.

### Service roles and BYPASSRLS

The following application paths need to bypass RLS and run under a
dedicated `BYPASSRLS` Postgres role provisioned by the deployment
pipeline (documented in Epic 18):

- `outbox` drain worker (needs to claim rows across every tenant).
- RGPD cascade / anonymization jobs (deletes children of a soft-deleted
  user regardless of tenant).
- `appendAudit` helper (writes rows even when the current tenant has
  `role != 'admin'`, e.g. on registration or on a failed Stripe
  webhook signature check — Req 22.1).
- Key-rotation / schema migrations (drizzle-kit `push` / `migrate`).

Everything else runs under the tenant role: one pooled role for the API
Gateway, wrapped in `withTenant` so every transaction carries the three
`app.*` session variables.

### Verifying RLS

- `drizzle-kit check` — confirms the snapshot chain is intact and the
  hand-authored SQL does not break the generator's diff.
- pgTAP tests in `packages/db/tests/rls/*.sql` (task 2.6) exercise one
  cross-tenant scenario per policy.
- Fast-check property test in `packages/db/tests/properties/rls.property.test.ts`
  (task 2.7) randomises pairs of studios and asserts zero rows are ever
  visible across the boundary.

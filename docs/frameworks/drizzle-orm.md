# Drizzle ORM — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                   | Value                                        |
| ----------------- | -------------------------------------------- |
| **Used**          | ^0.45.2                                      |
| **Latest stable** | **0.45.2** (current stable — stay here)      |
| **v1.0.0-rc.2**   | Release candidate — do NOT use in production |
| **drizzle-kit**   | ^0.31.10 (compatible)                        |

---

## HOLD — Do Not Upgrade to Drizzle v1.0.0-rc

Drizzle v1.0.0-rc.2 is a release candidate with significant API changes:

- New `casing` API (table/column name transformations)
- `codec` system for custom type serialization
- Changes to `$type<T>()` behavior for JSONB columns
- Migration tooling changes in drizzle-kit v1

**Risk**: RC-stage software. Wait for stable 1.0.0 GA before planning migration. The 0.45.x series remains fully maintained.

---

## Security

**0.45.2 patches SQL injection** in `sql.identifier()` and `sql.as()` (CWE-89). The project is on this version. Correct.

The project uses `sql` template tags with parameter binding (`${safe.userId}`) which prevents injection at the query level.

---

## Current Conventions (Correct)

### Prepared Statements

`prepare: false` in `packages/db/src/client.ts`. This **disables** prepared statements at the postgres.js driver level.

**Why correct**: Drizzle docs recommend `.prepare()` for connection-pooled queries. On Workers with Neon's serverless pooler, prepared statements conflict because poolers route queries to different backends where the prepared statement doesn't exist. `prepare: false` is the documented approach for serverless.

### RLS (Row Level Security)

Drizzle 0.45+ supports `pgTable.withRLS()` and `policy()` helpers. The project uses raw SQL migrations for RLS which is also valid. No migration needed.

Current `SET LOCAL` via `set_config()` pattern:

```ts
await tx.execute(sql`select set_config('app.user_id', ${safe.userId}, true)`);
```

Correct and idiomatic. The `true` argument makes the setting local to the transaction.

### Transactions

The `withTenant()` pattern is exemplary:

- Validates claims before touching DB
- Uses `SET LOCAL` (transaction-scoped, never leaks to pool)
- Parameter binding for all values

### Migration Strategy

drizzle-kit with TypeScript schema as source of truth + generated SQL files is the recommended approach and aligns with Drizzle's official workflow.

---

## Index Definition Syntax (Current)

Drizzle 0.45 uses the array syntax for index definitions:

```ts
// CURRENT — array syntax (correct)
export const users = pgTable('users', { ... }, (table) => [
    index('users_email_idx').on(table.email),
    uniqueIndex('users_email_unique').on(table.email),
]);

// OLD — object syntax (deprecated)
export const users = pgTable('users', { ... }, (table) => ({
    emailIdx: index('users_email_idx').on(table.email),
}));
```

The project uses the current array syntax. Do not regress to the object form.

---

## Drizzle v1 Preview (Do Not Use Yet)

Notable changes in v1 that will require migration:

```ts
// v0.45 — current
const result = await db.select().from(users).where(eq(users.id, id));

// v1 — mostly unchanged, but casing option is new
const db = drizzle(client, { schema, casing: 'camelCase' });
// Automatically maps camelCase JS fields to snake_case DB columns
```

The `casing` feature in v1 would eliminate the need for explicit `column_name` strings in schema definitions. Plan to adopt when v1 goes stable.

---

## Checklist

- [x] Version 0.45.2 (latest stable with security fix)
- [x] Parameter binding via `sql` tag (injection-safe)
- [x] `SET LOCAL` for RLS session variables
- [x] `prepare: false` correct for serverless pooling
- [x] `$type<T>()` for JSONB columns
- [x] Index definitions using current array syntax
- [ ] **Hold on v1.0.0-rc — wait for stable GA**
- [ ] Consider Drizzle's native `pgTable.withRLS()` for new tables (optional)
- [ ] Plan `casing: 'camelCase'` migration when v1 is stable

## Sources

- https://orm.drizzle.team/docs/rls
- https://orm.drizzle.team/docs/performance
- https://github.com/drizzle-team/drizzle-orm/releases/tag/0.45.2
- https://orm.drizzle.team/docs/v1-migration-guide

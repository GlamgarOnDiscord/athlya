# postgres.js — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                 | Value                                                   |
| --------------- | ------------------------------------------------------- |
| **Used**        | ^3.4                                                    |
| **Latest**      | 3.4.x (current stable)                                  |
| **Purpose**     | PostgreSQL driver (Workers-compatible, Neon-compatible) |
| **Paired with** | Drizzle ORM 0.45.2                                      |

---

## Why postgres.js

- Pure JavaScript with no native bindings — runs on Cloudflare Workers
- Native connection pooling
- Compatible with Neon's serverless PostgreSQL over WebSocket
- Used via Drizzle's `drizzle-orm/postgres-js` adapter
- Supports `nodejs_compat` flag's `net` and `tls` APIs

---

## Configuration (Correct)

```ts
const driverOptions = {
  max: 10, // pool size per isolate
  idle_timeout: 30, // seconds
  prepare: false, // required for serverless pooling
};
const client = postgres(connectionString, driverOptions);
```

### `prepare: false`

Prepared statements bind to a specific backend connection. Serverless poolers (Neon, Hyperdrive) route subsequent queries to different backends where the prepared statement doesn't exist. `prepare: false` ensures every query is self-contained.

Performance impact: negligible for simple SELECT/INSERT/UPDATE patterns.

### `max: 10`

Each Workers isolate maintains its own pool. With `max: 10`, one isolate handles 10 concurrent DB operations. Workers are short-lived — this rarely saturates. Cloudflare recommends small pool sizes.

**If Hyperdrive is added**: reduce to `max: 3-5` since Hyperdrive handles connection pooling at the edge.

---

## Usage Pattern

```ts
// Created once per isolate lifetime
export function createDb(connectionString: string): AthlyaDb {
  const client = postgres(connectionString, driverOptions);
  return drizzle(client, { schema });
}
```

The `createDb()` function is called once per isolate. The `postgres` instance handles pooling internally. Drizzle wraps it for query building.

---

## Transaction Pattern (Correct)

```ts
export async function withTenant<T>(db, claims, fn): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${safe.userId}, true)`);
    return fn(tx);
  });
}
```

`SET LOCAL` (via `set_config(..., true)`) is scoped to the transaction lifetime — variables never leak to the connection pool. Correct.

---

## Known Issues

| Issue                                         | Severity | Mitigation                            |
| --------------------------------------------- | -------- | ------------------------------------- |
| Neon cold start 300-500ms after scale-to-zero | Medium   | Add Cloudflare Hyperdrive binding     |
| No `COPY` support                             | Low      | Use multi-row `INSERT VALUES (...)`   |
| WebSocket handshake overhead on first query   | Low      | Mitigated by isolate-lifetime pooling |

---

## Hyperdrive Integration (Future)

When adding Hyperdrive:

```ts
// packages/db/src/client.ts
export function createDb(env: { DB_URL: string; HYPERDRIVE?: Hyperdrive }): AthlyaDb {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DB_URL;
  const client = postgres(connectionString, {
    max: env.HYPERDRIVE ? 3 : 10, // smaller pool when Hyperdrive handles pooling
    prepare: false,
  });
  return drizzle(client, { schema });
}
```

---

## Checklist

- [x] `prepare: false` for serverless pooling
- [x] Small pool size (10) appropriate for Workers
- [x] Single instance per isolate (no per-request creation)
- [x] Transaction-scoped session variables (`SET LOCAL`)
- [ ] Consider Hyperdrive binding for warm connections and lower cold-start latency

## Sources

- https://github.com/porsager/postgres
- https://neon.tech/docs/serverless/serverless-driver
- https://developers.cloudflare.com/hyperdrive/get-started/

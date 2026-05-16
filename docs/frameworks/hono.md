# Hono — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **Used** | ^4.12.18 |
| **Latest stable** | 4.12.18 (current) |
| **Runtime** | Cloudflare Workers |
| **Performance** | 402,820 ops/sec, <14KB (hono/tiny) |

---

## Security — v4.12.18 (Current — No Action Needed)

v4.12.18 includes three security fixes that are already applied:

1. **GHSA-p77w-8qqv-26rm**: Cache middleware leaked responses between users (fixed with `Vary: Authorization` and `Vary: Cookie`)
2. **GHSA-hm8q-7f3q-5f36**: JWT claim validation (`exp`, `nbf`, `iat`) was not enforced by Hono's JWT middleware
3. **GHSA-qp7p-654g-cw7p**: JSX CSS injection via style object values

The project uses custom JWT verification (via `jose`) not Hono's built-in JWT middleware. Issue #2 is not applicable. Issues #1 and #3 are patched.

---

## Architecture Assessment

### Gateway Pattern (worker.ts)

- Single `Hono<HonoEnv>` instance with typed bindings
- Middleware chain: security headers → tracing → OTel → serve-log → routes → error handlers
- `buildApp()` factory for test isolation
- Named export (`app`) for route composition

### Framework-Free Middleware Design

The project follows a portable middleware pattern:
- `SecurityHeadersContext` interface (not importing Hono types)
- `RateLimitContext` interface (duck-typed against Hono's `Context`)

This approach enables testing without Hono and potential framework migration. Correct.

### Error Handling

- RFC 9457 Problem Details envelope on all errors
- Centralized `registerErrorHandlers()` for 5xx
- Custom `notFound` handler with Problem Details shape
- `captureUnhandled` for Sentry integration

---

## Best Practices Applied

1. **Typed environment**: `HonoEnv` types for bindings and variables
2. **Onion middleware**: Headers before `next()`, logging after
3. **No global state mutations**: Each middleware sets context via `c.set()`
4. **Response headers applied early**: Security headers before any throw path

---

## Patterns to Review

### 1. Duck-typed header setting (rate-limit.ts)

```ts
const maybeHeader = (c as { header?: (k: string, v: string) => void }).header;
```

This avoids importing Hono types but is fragile. Since Hono is already a peer dep, prefer importing `Context` directly:

```ts
import type { Context } from 'hono';
function applyRateHeaders(c: Context, ...) { ... }
```

### 2. `app.fetch.bind(app)` in worker default export

```ts
const worker = { fetch: app.fetch.bind(app) };
```

Correct — `bind` ensures `this` context is preserved. No change needed.

---

## Features Not Yet Used (Available)

### Hono RPC — Type-Safe Client

```ts
// API side
export const routes = app
    .get('/users/:id', (c) => c.json({ name: 'Foo' }))
    .post('/reservations', zValidator('json', schema), handler);
export type AppRoutes = typeof routes;

// Client side (apps/web)
import { hc } from 'hono/client';
import type { AppRoutes } from '@athlya/api';
const client = hc<AppRoutes>('https://api.athlya.app');
const res = await client.reservations.$post({ json: payload });
```

Could replace the custom `createApiClient()` with full type inference. Tradeoff: creates a direct type dependency between `@athlya/api` and `@athlya/web`.

### `@hono/zod-validator`

```ts
import { zValidator } from '@hono/zod-validator';
app.post('/reservations', zValidator('json', CreateReservationSchema), (c) => {
    const body = c.req.valid('json'); // fully typed
});
```

Standard approach in the Hono ecosystem. Could replace the custom `middleware/validator.ts`.

### `hono/streaming` — SSE for Real-Time Updates

```ts
import { streamSSE } from 'hono/streaming';

app.get('/classes/:id/updates', (c) => {
    return streamSSE(c, async (stream) => {
        while (true) {
            await stream.writeSSE({ data: await getUpdate() });
            await stream.sleep(1000);
        }
    });
});
```

For future live class capacity updates (alternative to WebSocket/Durable Objects).

---

## Deprecated Patterns

No deprecated Hono APIs detected. The project uses:
- `new Hono<HonoEnv>()` — current
- `app.use('*', middleware)` — current
- `c.json()` / `c.body()` / `c.header()` / `c.set()` / `c.get()` — current
- `c.env` bindings access — current

---

## Checklist

- [x] Typed HonoEnv for bindings and variables
- [x] Framework-free middleware interfaces
- [x] RFC 9457 Problem Details on all error paths
- [x] Security headers before any handler
- [x] Trace propagation (W3C traceparent)
- [x] Structured logging per request
- [x] Queue + scheduled handler wiring
- [x] Hono >= 4.12.18 (security fixes applied)
- [ ] Replace duck-typed `header` cast with imported `Context` type
- [ ] Consider Hono RPC for type-safe API client (replaces createApiClient)
- [ ] Consider `@hono/zod-validator` (replaces custom validator middleware)
- [ ] Evaluate `hono/streaming` for real-time class updates

## Sources

- https://hono.dev/docs/
- https://hono.dev/docs/getting-started/cloudflare-workers
- https://hono.dev/docs/guides/rpc
- https://hono.dev/docs/helpers/streaming
- https://github.com/honojs/hono/releases/tag/v4.12.18

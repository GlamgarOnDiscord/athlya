# fast-check — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                        | Value                     |
| ---------------------- | ------------------------- |
| **Used**               | ^3.23.2                   |
| **Latest v3**          | 3.23.2 (stable)           |
| **Latest v4**          | **4.1.0** (released 2026) |
| **@fast-check/vitest** | ^0.3.0                    |

---

## fast-check 4.x — Breaking Changes

fast-check 4.0 was released in 2026 with the following breaking changes:

| Change                                                                        | Impact                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------- |
| `fc.integer()` now requires explicit `min`/`max` — no more unbounded integers | Update all `fc.integer()` calls without bounds |
| `fc.string()` encoding option renamed from `'ascii'` to `'utf-8'`             | Check string arbitraries in test files         |
| `fc.commands()` API changed — `ICommand` renamed to `Command`                 | Update model-based tests if used               |
| `fc.sample()` returns typed tuple instead of array                            | Minor — update destructuring                   |
| New `fc.gen()` — function-based arbitrary composition                         | Optional, does not replace existing APIs       |

### Upgrade Path

```bash
pnpm add -D fast-check@^4 @fast-check/vitest@latest -w
```

Verify `@fast-check/vitest` 0.3.x supports fast-check 4 — a new version of the integration package may be required.

```bash
pnpm why fast-check @fast-check/vitest
# Ensure versions are compatible
```

---

## Usage in Project

| Package                  | Test File                        | What's Tested                                      |
| ------------------------ | -------------------------------- | -------------------------------------------------- |
| `packages/db`            | `rls.property.test.ts`           | RLS policies hold under random claims/data         |
| `packages/reservations`  | `booking.property.test.ts`       | No double-booking under concurrent random bookings |
| `packages/auth`          | _(devDep present, no test file)_ | Not yet used                                       |
| `packages/billing`       | _(devDep present, no test file)_ | Not yet used                                       |
| `packages/notifications` | _(devDep present, no test file)_ | Not yet used                                       |
| `packages/ratelimit`     | _(devDep present, no test file)_ | Not yet used                                       |

---

## Exemplary Tests (Already Implemented)

### RLS Property Test (`packages/db`)

- Generates random user claims, studio IDs, roles
- Verifies RLS policies reject cross-tenant reads across all table/role combinations
- Uses testcontainers for real PostgreSQL
- `numRuns: 20` with truncate+seed per run

### Booking Property Test (`packages/reservations`)

- Concurrent bookings never exceed capacity
- State machine transitions valid under random operation sequences
- Optimistic lock prevents capacity modification races

---

## Missing Property Tests (High Value)

### 1. Auth — JWT Round-Trip

```ts
import { fc, test } from '@fast-check/vitest';

test.prop([
  fc.record({ sub: fc.uuid(), studio: fc.uuid(), role: fc.constantFrom('member', 'owner') }),
])('JWT sign/verify is identity for valid claims', async (claims) => {
  const token = await sign(claims, privateKey);
  const verified = await verify(token, publicKey);
  expect(verified.sub).toBe(claims.sub);
});
```

### 2. Rate Limiter — Monotonicity

```ts
test.prop([
  fc.integer({ min: 1, max: 100 }), // numRequests
  fc.integer({ min: 1, max: 60 }), // windowSeconds
])('remaining never increases without time passing', async (numRequests, window) => {
  const results = await Promise.all(Array.from({ length: numRequests }, () => checkLimit()));
  const remaining = results.map((r) => r.remaining);
  // Remaining should be non-increasing
  for (let i = 1; i < remaining.length; i++) {
    expect(remaining[i]).toBeLessThanOrEqual(remaining[i - 1]);
  }
});
```

### 3. Sliding Window — Temporal Correctness

Generate random timestamps and verify the window correctly expires old entries.

---

## Checklist

- [x] Property tests for RLS (critical security invariant)
- [x] Property tests for booking (critical business invariant)
- [x] @fast-check/vitest integration for Vitest runner
- [ ] **Evaluate upgrade to fast-check 4.x** (check @fast-check/vitest compat — note: @fast-check/vitest@0.4.1 is now on Vitest 4, verify fast-check itself separately)
- [ ] Add property tests for auth (JWT round-trip, rate-limit monotonicity)
- [ ] Add property tests for rate limiter (sliding window correctness)
- [ ] Add property tests for billing (idempotency under retries)

## Sources

- https://fast-check.dev/
- https://fast-check.dev/docs/migration/from-3x-to-4x
- https://github.com/dubzzz/fast-check/releases/tag/fast-check%404.0.0

# Vitest — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                        | Value                                     |
| ---------------------- | ----------------------------------------- |
| **Used**               | ^3.2.4                                    |
| **Latest stable**      | **4.1.0** (March 2026)                    |
| **Gap**                | Major version behind — plan upgrade       |
| **@fast-check/vitest** | ^0.3.0 → verify 4.x compat before upgrade |

---

## URGENT — Vitest 4.x (March 2026)

### Breaking Changes 3.x → 4.x

| Change                                                    | Impact                                           |
| --------------------------------------------------------- | ------------------------------------------------ |
| `pool: 'forks'` is now the default (was `threads`)        | Isolates better, slightly slower cold start      |
| `browser.provider` API changed                            | Not applicable (project uses jsdom)              |
| `vi.mock()` hoisting is now stricter                      | Mocks must be defined before imports in the file |
| `globals: false` required explicitly                      | Already correct in project                       |
| Inline snapshots format changed                           | Re-generate with `vitest -u`                     |
| `coverage.reporter` default changed to `['text', 'html']` | Adjust CI config if needed                       |

### New in Vitest 4.x

- **`vi.waitFor()` improvements**: timeout configurable globally via `test.waitForTimeout`
- **`expect.soft()` chaining**: Multiple soft assertions before fail
- **`test.for()` (Table-driven tests)**: Cleaner parameterized tests
  ```ts
  test.for([
    [1, 2, 3],
    [3, 4, 7],
  ])('adds %s + %s = %s', ([a, b, expected]) => {
    expect(a + b).toBe(expected);
  });
  ```
- **`--reporter=junit` improved**: CI-grade output with timestamps
- **Vitest UI 4.x**: File tree + coverage overlay in browser
- **`test.sequential`**: Runs tests in the same file sequentially without disabling parallelism globally

### Upgrade Plan

```bash
pnpm add -D vitest@^4 @fast-check/vitest@latest -w
# Verify @fast-check/vitest is compatible with Vitest 4 before proceeding
pnpm test   # check for failures
# Re-generate snapshots if any inline snapshot tests exist
pnpm vitest --update
```

---

## Current Configuration

### apps/web/vitest.config.ts

```ts
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
```

- `globals: false` — explicit imports required (`import { describe, it, expect } from 'vitest'`). Correct, prevents global pollution.
- `jsx: 'automatic'` — React 19 JSX transform. Required since Next.js uses `"jsx": "preserve"`.
- `jsdom` environment — correct for React component tests.

### Package-level configs

No custom vitest config in packages — inherits Vitest defaults (node environment, correct for non-React packages).

---

## Testing Patterns

### Property-Based Testing

Using `fast-check` with `@fast-check/vitest`:

```ts
import { fc } from '@fast-check/vitest';
```

Excellent practice for invariants (rate limiter, circuit breaker, event validation).

### Integration Tests

Using `testcontainers` for PostgreSQL:

```json
"@testcontainers/postgresql": "^10.13.0"
```

Real database tests for RLS policies and migration correctness. Best practice.

### Component Tests

Using `@testing-library/react` + `jsdom`:

- `LocaleSwitcher.test.tsx` — UI behavior tests
- `cookies.test.ts` — auth cookie handling

---

## Recommendations

### 1. Shared `vitest.workspace.ts`

A workspace-level file consolidates settings:

```ts
// vitest.workspace.ts (root)
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace(['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts']);
```

### 2. Coverage Thresholds (CI)

```ts
// vitest.config.ts
test: {
    coverage: {
        thresholds: { lines: 80, functions: 80 },
        reporter: ['text', 'html', 'lcov'],
    }
}
```

### 3. `@cloudflare/vitest-pool-workers` for Worker Tests

For packages/api (Hono + Workers), use the official Cloudflare pool:

```bash
pnpm add -D @cloudflare/vitest-pool-workers -w
```

```ts
// packages/api/vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: './wrangler.toml' } },
    },
  },
});
```

This runs tests in the actual Workers runtime (V8 isolates), not Node — catches Workers-specific APIs.

---

## Checklist

- [x] Vitest 3.x with proper config
- [x] Property-based testing with fast-check
- [x] Integration tests with testcontainers
- [x] React component tests with testing-library
- [x] jsdom for browser-like environment
- [x] `globals: false` (explicit imports)
- [ ] **Upgrade Vitest 3.x → 4.x** (verify @fast-check/vitest compat first)
- [ ] Add shared `vitest.workspace.ts` for consistent settings
- [ ] Add coverage thresholds for CI
- [ ] Evaluate `@cloudflare/vitest-pool-workers` for packages/api

## Sources

- https://vitest.dev/guide/
- https://vitest.dev/guide/workspace.html
- https://github.com/vitest-dev/vitest/releases/tag/v4.0.0
- https://developers.cloudflare.com/workers/testing/vitest-integration/

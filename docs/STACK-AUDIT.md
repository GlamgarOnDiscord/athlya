# Athlya Stack Audit — 2026-05-14

> **Archive snapshot — 2026-05-14.** Ce document est un audit daté ; ne pas l'utiliser comme documentation opérationnelle courante. Plusieurs action items listés ici sont résolus (flat ESLint config, `next lint` retiré, etc.). Vérifier le code source pour l'état actuel.

## Architecture Overview

**Type**: pnpm monorepo (workspaces) + Turborepo  
**License**: AGPL-3.0-only  
**Target**: Multi-tenant fitness platform (RGPD-first, edge-first)

---

## Complete Stack — Version Table

### Core Infrastructure

| Technology | Used     | Latest Stable | Status                             |
| ---------- | -------- | ------------- | ---------------------------------- |
| pnpm       | 9.15.9   | 9.x           | Current                            |
| Turborepo  | ^2.9.12  | 2.9.12        | Current — v3 RC available, hold    |
| TypeScript | ^5.9.3   | **6.0**       | Upgrade needed (see typescript.md) |
| Node.js    | >=20 <21 | 20.x LTS      | Current                            |

### Frontend (apps/web + apps/studio)

| Technology           | Used    | Latest Stable | Status                                 |
| -------------------- | ------- | ------------- | -------------------------------------- |
| Next.js              | ^16.2.6 | 16.2.6        | Current — security patches applied     |
| React                | ^19.2.0 | 19.2.6        | Security patch needed (CVE-2025-55182) |
| React DOM            | ^19.2.0 | 19.2.6        | Same as React                          |
| Tailwind CSS         | ^4.3.0  | 4.3.x         | Current                                |
| @tailwindcss/postcss | ^4.3.0  | 4.3.x         | Current                                |
| PostCSS              | ^8.4.49 | 8.x           | Current                                |

### Backend (packages/api)

| Technology         | Used         | Latest Stable | Status                           |
| ------------------ | ------------ | ------------- | -------------------------------- |
| Hono               | ^4.12.18     | 4.12.18       | Current                          |
| Cloudflare Workers | runtime 2026 | —             | Current                          |
| Wrangler           | ^4.0.0       | 4.91.0        | Minor update available           |
| jose               | ^5.9.6       | **6.2.3**     | Major upgrade available (v6)     |
| @upstash/redis     | ^1.35.6      | **1.38.0**    | Breaking change in 1.38 — verify |
| Zod                | ^4.4.3       | 4.4.3         | Current                          |

### Database (packages/db)

| Technology        | Used     | Latest Stable | Status                  |
| ----------------- | -------- | ------------- | ----------------------- |
| Drizzle ORM       | ^0.45.2  | 0.45.2        | Current — hold on v1 RC |
| Drizzle Kit       | ^0.31.10 | 0.31.10       | Current                 |
| postgres.js       | ^3.4     | 3.4.x         | Current                 |
| PostgreSQL (Neon) | 17       | 17            | Current                 |

### Auth (packages/auth)

| Technology     | Used    | Latest Stable | Status                   |
| -------------- | ------- | ------------- | ------------------------ |
| bcryptjs       | ^3.0.2  | 3.0.2         | Current                  |
| jose           | ^5.9.6  | 6.2.3         | Major upgrade available  |
| @upstash/redis | ^1.35.6 | 1.38.0        | Breaking change — verify |

### Testing

| Technology                | Used     | Latest Stable | Status                            |
| ------------------------- | -------- | ------------- | --------------------------------- |
| Vitest                    | ^3.2.4   | **4.1.0**     | Major version behind — upgrade    |
| fast-check                | ^3.23.2  | **4.1.0**     | Major version behind — evaluate   |
| @fast-check/vitest        | ^0.3.0   | 0.3.x         | Verify v4 compat before upgrading |
| @testing-library/react    | ^16.1.0  | 16.x          | Current                           |
| @testing-library/jest-dom | ^6.6.3   | 6.x           | Current                           |
| jsdom                     | ^26.0.0  | 26.x          | Current                           |
| testcontainers            | ^10.13.0 | 10.x          | Current                           |

### Linting / Formatting

| Technology                   | Used    | Latest Stable | Status                        |
| ---------------------------- | ------- | ------------- | ----------------------------- |
| ESLint                       | ^9.39.1 | **10.3.0**    | Upgrade needed (EOL Aug 2026) |
| typescript-eslint            | ^8.50.0 | **8.59.3**    | Minor update available        |
| eslint-plugin-import         | ^2.32.0 | 2.32.0        | Current                       |
| eslint-plugin-unused-imports | ^4.2.0  | 4.2.0         | Current                       |
| eslint-config-prettier       | ^10.1.8 | 10.1.8        | Current                       |
| Prettier                     | ^3.8.3  | 3.x           | Current                       |

---

## Security Issues — Action Required

| Severity | Package    | Issue                                                                      | Fix                      |
| -------- | ---------- | -------------------------------------------------------------------------- | ------------------------ |
| CRITICAL | React 19   | CVE-2025-55182 CVSS 10.0 — RCE via Server Components payload               | Verify lockfile → 19.2.6 |
| HIGH     | React 19   | CVE-2025-55184 CVSS 7.5 — DoS                                              | Same fix                 |
| MEDIUM   | React 19   | CVE-2025-55183 — source code leak                                          | Same fix                 |
| HIGH     | Next.js 16 | 13 CVEs patched in May 2026 (DoS, SSRF, cache poisoning, XSS, auth bypass) | Verify lockfile → 16.2.6 |

```bash
pnpm why react       # must show 19.2.6+
pnpm why next        # must show 16.2.6+
```

---

## Upgrade Priority Queue

### P0 — Security (Do Now)

1. Verify React lockfile resolves to 19.2.6 (CVSS 10.0 CVE)
2. Verify Next.js lockfile resolves to 16.2.6 (May 2026 patch)

### P1 — EOL Risk (Within 3 Months)

3. **ESLint 9 → 10** (EOL August 6, 2026)
   - Migrate `apps/web/.eslintrc.json` → `apps/web/eslint.config.js`
   - Update `lint` script: `next lint` → `eslint src --ext .ts,.tsx`
   - See `eslint.md` + `eslint-plugins.md`

### P2 — Major Upgrades (Plan for Q3 2026)

4. **TypeScript 5.9 → 6.0** — 7-step migration plan in `typescript.md`
5. **Vitest 3.x → 4.x** — verify `@fast-check/vitest` compat first
6. **jose 5.x → 6.x** — rename `algorithms` → `allowedAlgorithms`, check Uint8Array

### P3 — Minor / Optional

7. Upgrade `typescript-eslint ^8.50 → ^8.59`
8. Upgrade `@upstash/redis` → 1.38.0 (verify pipeline atomicity)
9. Bump Wrangler `compatibility_date` to 2026-03-01
10. Evaluate `fast-check 4.x`

---

## Architectural Patterns

### Strengths

1. **Multi-tenant with RLS**: PostgreSQL Row Level Security with `SET LOCAL` session variables per transaction. Defense-in-depth approach.
2. **Event-driven architecture**: Typed event bus with discriminated union (`AthlyaEventSchema`), outbox pattern, DLQ handling.
3. **Security-first**: CSP with per-request nonce, HSTS preload, X-Frame-Options, Permissions-Policy, bcrypt cost 12, JWT RS256 with 90-day key rotation.
4. **Edge-first**: Cloudflare Workers with Smart Placement, sliding-window rate limiting, circuit breaker per dependency.
5. **Clean package boundaries**: Each domain (auth, billing, members, reservations, notifications) is a separate workspace package.
6. **Modern conventions**: ESM-only, flat ESLint config, TypeScript strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
7. **Framework-free middleware**: Security headers, rate limiter, circuit breaker typed against minimal interfaces (not Hono-specific).
8. **Property-based testing**: fast-check for invariant testing (RLS + booking correctness).
9. **Tailwind 4 CSS-first**: `@import 'tailwindcss'` + `@theme` blocks, design token pipeline.
10. **Next.js 16 proxy pattern**: `proxy.ts` convention (replaces `middleware.ts`).

### Known Technical Debt

| Item                                                | File                      | Action                                      |
| --------------------------------------------------- | ------------------------- | ------------------------------------------- |
| `Object.setPrototypeOf` in error classes            | `circuit-breaker.ts`      | Remove — not needed with ES2022+ target     |
| 72-byte bcrypt truncation vs 256-char Zod limit     | `packages/auth`           | Cap at 72 or pre-hash with SHA-256          |
| `apps/web/.eslintrc.json` legacy format             | `apps/web/.eslintrc.json` | Migrate to flat config (ESLint 10 required) |
| `min-h-screen` in some components                   | Multiple                  | Replace with `min-h-dvh`                    |
| `import/order` not enforced on `@athlya/*` packages | eslint config             | Add `@athlya/*` to import groups            |

---

## Security Posture

### Verified Protections

- JWT RS256 with 90-day key rotation and 24h grace period
- bcrypt cost 12 (OWASP 2024 lower bound)
- HIBP breached-password check at registration
- Per-request CSP nonce via Edge proxy (`proxy.ts`)
- Cloudflare Turnstile integration (bot protection)
- Rate limiting: 100 rps/IP + 500 rps/user (sliding window, Redis)
- Idempotency middleware for mutation safety
- Audit log (append-only)
- No secrets in repository (no `.env` files committed)
- HSTS preload (2 years, includeSubDomains)
- Replay protection via Redis SET NX EX for QR tokens
- RLS on all tenant-scoped tables

### Open Security Items

| Item                                        | Risk   | Action                                                 |
| ------------------------------------------- | ------ | ------------------------------------------------------ |
| No explicit CORS configuration visible      | Medium | Verify Cloudflare handles CORS or add explicit config  |
| No `Content-Security-Policy-Report-Only`    | Low    | Add reporting endpoint for CSP violation monitoring    |
| `password_hash` nullable (OAuth-only users) | Low    | Ensure all code paths that hash/compare check for null |
| bcrypt 72-byte truncation                   | Low    | Address as documented in bcryptjs.md                   |

---

## Performance Observations

| Item                                           | Status                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| `prepare: false` in postgres.js                | Correct for serverless (Neon/Hyperdrive)              |
| No Hyperdrive binding                          | Neon cold start 300-500ms — add when observed in prod |
| Module-scope Redis cache in rate-limit.ts      | Correct per-isolate lifetime                          |
| Circuit breaker per-isolate                    | Documented tradeoff, acceptable for Workers           |
| Next.js ISR/PPR                                | Not yet enabled — `cacheComponents: true` pending     |
| Design tokens CSS hand-mirrored from tokens.ts | Drift risk — consider auto-generation                 |

---

## Missing Features (Listed in project.md, Not Implemented)

| Feature                           | Status              | Notes                                         |
| --------------------------------- | ------------------- | --------------------------------------------- |
| Cloudflare Hyperdrive             | Not wired           | Add `[[hyperdrive]]` binding to wrangler.toml |
| TanStack Query                    | Not in package.json | Optional — current SWR-style fetch works      |
| Zustand                           | Not in package.json | Optional — AuthContext covers current needs   |
| `@cloudflare/vitest-pool-workers` | Not installed       | High value for packages/api tests             |
| Remote caching (Turborepo)        | Not configured      | Consider for CI                               |

---

_Audit updated: 2026-05-14_  
_Previous audit: 2026-05-10_

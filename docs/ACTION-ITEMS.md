# Prioritized Action Items — Athlya Audit

## Priority 1: Security (Fix Now)

### ~~S1. Verify Hono 4.12.18 in lockfile~~ VERIFIED OK
Lockfile resolves `hono@4.12.18` exactly. No action needed.

### S2. bcrypt 72-byte password truncation
**Risk**: Zod schema allows `.max(256)` (`packages/shared/src/schemas/api.ts:120`) but bcrypt truncates at 72 bytes. Characters 73-256 provide zero security.  
**Files**: `packages/shared/src/schemas/api.ts:120`, `packages/auth/src/password.ts`  
**Action**: Either cap Zod schema at `.max(72)`, or use `bcrypt(SHA256(password))` pattern, or document as accepted  
**Source**: bcrypt specification, OWASP Password Storage Cheatsheet

### ~~S3. Update `@cloudflare/workers-types`~~ VERIFIED OK
Lockfile resolves to `4.20260509.1` (latest). The `^4.20241218.0` range in package.json is permissive enough. No action needed.

### S4. Add CSP report-uri/report-to
**Risk**: CSP violations invisible — no monitoring before they block users  
**File**: `apps/web/src/lib/csp.ts`  
**Action**: Add `report-to` directive pointing to a reporting endpoint (or use Report URI service)  
**Source**: MDN CSP reference

### S5. No CORS middleware on API gateway
**Risk**: Cross-origin requests from web app (if hosted on different subdomain) will be blocked by browser  
**File**: `packages/api/src/worker.ts`  
**Action**: Add Hono's `cors()` middleware with explicit allowed origins (`https://athlya.app`, `https://staging.athlya.app`). If web and API share same origin (proxied via Next.js), this is a non-issue — verify deployment topology.  
**Source**: Hono CORS middleware docs, MDN CORS reference

---

## Priority 2: Correctness (Fix Soon)

### C1. Refactor AuthProvider to `useSyncExternalStore`
**Risk**: Potential state tearing under React 19 concurrent rendering  
**File**: `apps/web/src/lib/auth/AuthContext.tsx`  
**Action**: Replace `useState` + `useEffect` subscription with `useSyncExternalStore`  
**Source**: React 19 docs — useSyncExternalStore

### C2. Remove `Object.setPrototypeOf` from error classes
**Risk**: Unnecessary with ES2022 target; adds confusion  
**File**: `packages/api/src/circuit-breaker.ts`  
**Action**: Remove `Object.setPrototypeOf(this, new.target.prototype)` — native `extends Error` handles prototype chain with `target: "ES2022"`  
**Source**: TypeScript ES2022 class compilation

### C3. Resolve dual ESLint config in apps/web
**Risk**: Confusion about which lint rules apply  
**Files**: `apps/web/.eslintrc.json` + root `eslint.config.js`  
**Action**: Check if `eslint-config-next` supports flat config; if yes, migrate. If no, document the coexistence.  
**Source**: ESLint 9 flat config docs

---

## Priority 3: Performance (Improve When Ready)

### P1. Enable Cache Components (PPR) for public pages
**Risk**: None (opt-in feature)  
**File**: `apps/web/next.config.ts`  
**Action**: Add `cacheComponents: true`, then add `'use cache'` + `cacheLife()` to static/semi-static pages  
**Source**: Next.js 16 Cache Components docs

### P2. Add Hyperdrive binding for connection pooling
**Risk**: Higher cold-start latency without Cloudflare's connection pooler  
**File**: `packages/api/wrangler.toml`  
**Action**: Create Hyperdrive config in Cloudflare dashboard, add `[[hyperdrive]]` binding  
**Source**: Cloudflare Hyperdrive docs

### P3. Add Suspense/loading boundaries
**Risk**: Poor perceived performance without streaming indicators  
**Files**: `apps/web/src/app/loading.tsx`, `apps/web/src/app/error.tsx`  
**Action**: Create route-level loading and error boundaries  
**Source**: Next.js 16 App Router conventions

---

## Priority 4: Modernization (Optional Improvements)

### M1. Replace `[color:var(...)]` with direct Tailwind utilities
**Files**: Multiple components in `apps/web/src/`  
**Action**: Verify `@theme` registration makes colors directly usable as `text-muted-foreground`, `bg-brand-primary` etc.  
**Impact**: Cleaner markup, better DX

### M2. Consider Hono RPC for type-safe API client
**Files**: `apps/web/src/lib/api/client.ts`, `packages/api/src/routes/`  
**Action**: Evaluate replacing custom API client with Hono's `hc` RPC client for auto-typed endpoints  
**Impact**: Type-safe API calls, no manual type maintenance

### M3. Consider `@hono/zod-validator` for route validation
**Files**: `packages/api/src/middleware/validator.ts`  
**Action**: Evaluate standard Zod validator vs custom implementation  
**Impact**: Less custom code, better Hono ecosystem integration

### M4. Add `server-only` guard to server utilities
**Files**: Server-only modules in `apps/web/src/lib/`  
**Action**: Add `import 'server-only'` to modules that should never be imported client-side  
**Impact**: Build-time error if accidentally imported in client component

### M5. Run Tailwind upgrade check
**Action**: `npx @tailwindcss/upgrade` to verify no v3 patterns remain  
**Impact**: Clean Tailwind 4 usage

### M6. Auto-generate tokens.css from tokens.ts
**Files**: `packages/shared/src/tokens.ts`, `apps/web/src/styles/tokens.css`  
**Action**: Build step to generate CSS from TS source (eliminates drift risk)  
**Impact**: Single source of truth for design tokens

---

## Priority 5: Technical Debt (Low Priority)

### D1. Login form `maxLength={256}` should match Zod schema
**File**: `apps/web/src/app/login/LoginForm.tsx:119`  
**Detail**: `maxLength={256}` is correct per current Zod schema but inconsistent with bcrypt's 72-byte limit. If S2 is resolved by capping at 72, update this too.

### D2. Login form uses `fetch` directly instead of API client
**File**: `apps/web/src/app/login/LoginForm.tsx:67`  
**Detail**: `LoginForm` calls `fetch('/api/auth/login')` directly while an `ApiClient` exists in `lib/api/client.ts`. Minor inconsistency — may be intentional (login doesn't need auth headers).

### D3. Consider property-based tests for auth service
**Detail**: `packages/auth` has `fast-check` as devDep but no `.property.test.ts` files. The `packages/db` and `packages/reservations` already have excellent property tests. Consider adding for JWT signing/verification invariants.

---

## No Action Required (Confirmed Correct)

| Pattern | Reason |
|---|---|
| `prepare: false` in Drizzle | Required for serverless connection pooling (Neon) |
| Module-scope Redis cache | Correct per-isolate pattern for Workers |
| Per-isolate circuit breaker | Documented tradeoff, acceptable for Workers |
| Custom auth (not Better Auth) | Deliberate choice — full service layer with DI, OAuth, throttle, HIBP |
| `SET LOCAL` for RLS | Correct transaction-scoped session variables |
| Zod 4 discriminated unions | Current API, no deprecated patterns |
| Flat ESLint config at root | Modern, correct approach |
| Tailwind 4 CSS-first | Already using new @theme + @import pattern |
| Next.js 16 proxy.ts | Already on new convention |
| Async `headers()` | Already awaited (React 19 requirement) |
| Hono 4.12.18 | Latest stable with all security patches |
| `@cloudflare/workers-types` | Resolved to 4.20260509.1 (current) |
| Login throttle (5/15min) | Implemented in `packages/auth/src/throttle.ts` |
| HIBP breached-password check | K-anonymity implementation, fail-closed policy |
| Turnstile middleware | Implemented for register + login routes |
| Idempotency middleware | Covers all mutations, 24h TTL |
| QR replay protection | Redis-backed with jti + TTL matching token lifetime |
| Timing-safe login | Dummy bcrypt on missing/OAuth-only users (oracle prevention) |
| OAuth verification | Apple + Google JWKS with proper issuer/audience checks |
| Drizzle ORM 0.45.2 | Latest stable with SQL injection fix |

---

*Generated: 2026-05-10*  
*Based on: Official documentation, changelogs, and security advisories*

# Security Audit — Athlya

_Last updated: 2026-05-14_

## Authentication

### JWT (packages/auth/src/jwt.ts)

| Aspect       | Implementation          | Assessment                                 |
| ------------ | ----------------------- | ------------------------------------------ |
| Algorithm    | RS256                   | Good (asymmetric, public key verifiable)   |
| Access TTL   | 15 min                  | Good (short-lived)                         |
| Refresh TTL  | 30 days                 | Acceptable (rotated on use)                |
| Key rotation | 90-day cycle, 24h grace | Good (matches OWASP guidance)              |
| Library      | jose ^5.9.6             | v6.2.3 available — upgrade path in jose.md |
| Claims       | sub, studio, role       | Minimal, correct                           |

### Password Hashing (packages/auth/src/password.ts)

| Aspect               | Implementation             | Assessment                                              |
| -------------------- | -------------------------- | ------------------------------------------------------- |
| Algorithm            | bcrypt                     | Good (OWASP recommended)                                |
| Cost factor          | 12                         | Meets OWASP 2024 minimum                                |
| Library              | bcryptjs ^3.0.2            | Pure JS, Workers-compatible                             |
| Empty password check | Yes (throws)               | Good                                                    |
| Max length           | Zod + forms `.max(72)`     | Resolved 2026-05-27 — wire cap before bcrypt |

Zod `RegisterRequestSchema` / `LoginRequestSchema` and web password inputs cap at 72 characters so bcrypt silent truncation never applies to user passwords.

### HIBP Check (packages/auth/src/hibp.ts)

k-Anonymity model (only first 5 chars of SHA-1 sent to API). Correct implementation.

## Transport Security

| Header                    | Value                                        | Source                                       |
| ------------------------- | -------------------------------------------- | -------------------------------------------- |
| Strict-Transport-Security | max-age=63072000; includeSubDomains; preload | next.config.ts + security-headers middleware |
| X-Frame-Options           | DENY                                         | Both layers                                  |
| X-Content-Type-Options    | nosniff                                      | Both layers                                  |
| Referrer-Policy           | strict-origin                                | Both layers                                  |
| Permissions-Policy        | camera=(), microphone=(), geolocation=()     | API middleware                               |
| Content-Security-Policy   | strict per-request nonce                     | proxy.ts                                     |

Both the Next.js web app and the Hono API gateway emit security headers independently. Belt-and-braces approach.

## Content Security Policy (apps/web/src/lib/csp.ts)

```
default-src 'self';
script-src 'self' 'nonce-...' 'strict-dynamic' challenges.cloudflare.com;
style-src 'self' 'nonce-...';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' <apiUrl> challenges.cloudflare.com;
frame-src 'self' challenges.cloudflare.com;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

**Assessment**: Strong CSP. No `unsafe-inline` or `unsafe-eval`. `'strict-dynamic'` allows scripts loaded by nonced scripts (required for Next.js runtime chunks). Turnstile origins pre-whitelisted.

**Missing**: `report-uri` or `report-to` directive for CSP violation monitoring. Consider adding `Content-Security-Policy-Report-Only` in staging first.

## Rate Limiting

| Bucket   | Limit   | Window   | Key                                 |
| -------- | ------- | -------- | ----------------------------------- |
| Per IP   | 100 req | 1 second | CF-Connecting-IP or X-Forwarded-For |
| Per user | 500 req | 1 second | JWT userId                          |

Sliding window algorithm via Upstash Redis. Authenticated users get the higher limit (IP bucket bypassed). Unknown IPs share one bucket (cannot bypass by stripping headers).

**VERIFIED**: Login-specific throttle exists in `packages/auth/src/throttle.ts`: 5 attempts / 15 min per (IP, email) pair. Uses the same sliding-window primitive. Email is normalized (lowercase+trim) to prevent case-bypass.

Additional confirmed security mechanisms:

- Refresh token: `HttpOnly`, `Secure` (prod), `SameSite=Lax` cookie — never JS-accessible
- Timing-oracle prevention: dummy bcrypt on missing/OAuth-only users during login
- QR check-in: 120s TTL, jti-based single-use (Redis replay store), studio-scoped, `kind` discriminator prevents token confusion
- OAuth: Apple + Google ID-token verification via remote JWKS with proper issuer/audience checks
- HIBP fail-closed: registration rejected if HIBP API is unavailable (not fail-open)

## Multi-Tenant Isolation

### Database (RLS)

Three session variables set per transaction:

- `app.user_id` — drives row-level read policies
- `app.studio_id` — tenant boundary
- `app.role` — RBAC enforcement

`SET LOCAL` scoped to transaction — never leaks to connection pool.

### Validation

Claims validated with:

- UUID v1-8 regex for userId and studioId
- Enum check for role ('member' | 'coach' | 'admin')
- Validation happens BEFORE any SQL

### Cross-tenant behavior

Query returns 0 rows (not 403) — prevents resource existence disclosure. API translates to 404.

## Error Handling (Information Leakage)

The `registerErrorHandlers` in worker.ts:

- 4xx: Includes Problem Details with `title` only (no stack, no message for auth errors)
- 5xx: Generic "Internal Server Error" — never leaks `err.message` or `err.stack`
- Trace ID echoed for correlation but no sensitive data

## Secrets Management

- No `.env` files committed (verified)
- Cloudflare Secrets for production (set via `wrangler secret put`)
- `.dev.vars` for local dev (git-ignored)
- Key pair loaded from PEM in dev, from Secrets in prod

## Identified Risks

### Priority 0 (Security — Immediate)

0. **React 19 CVE-2025-55182 CVSS 10.0** (RCE via Server Components): Verify lockfile resolves React to 19.2.6+
1. **Next.js 16 May 2026 patch** (13 CVEs): Verify lockfile resolves Next.js to 16.2.6+

### Priority 1 (Should Fix)

1. **bcrypt 72-byte truncation**: Add length validation or document accepted behavior
2. **Missing CSP report-uri**: No monitoring of policy violations
3. **`@cloudflare/workers-types`**: Resolves to 4.20260509.1 — current

### Priority 2 (Consider)

4. **No CORS configuration**: API may need explicit CORS for cross-origin web app requests (if hosted on different subdomain)
5. **Login rate limit**: Auth-specific throttle (5 attempts/15 min) verified in packages/auth/src/throttle.ts
6. **Token refresh race condition**: If two tabs try to refresh simultaneously, one may get a revoked token error

### Priority 3 (Future)

7. **CSP Report-Only** header in staging for monitoring before enforcement changes
8. **Subresource Integrity (SRI)**: For any third-party scripts (Turnstile already loaded via frame)
9. **Certificate Transparency monitoring**: Detect unauthorized certs for athlya.app

## Source

- OWASP Authentication Cheatsheet
- OWASP Password Storage Cheatsheet
- MDN Content-Security-Policy reference
- RFC 9457 (Problem Details for HTTP APIs)

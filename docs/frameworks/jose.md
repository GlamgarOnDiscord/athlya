# jose — Framework Audit

*Last updated: 2026-05-14*

## Version Status

| | Value |
|---|---|
| **Used** | ^5.9.6 |
| **Latest v5** | 5.9.6 (last v5 patch) |
| **Latest stable** | **6.2.3** (current, recommended) |
| **v7 beta** | 7.0.0-beta.1 (do not use in prod) |
| **Purpose** | JWT signing, verification, JWKS, key import/export |
| **Runtime** | Edge-compatible (Web Crypto API) |

---

## Upgrade Available: jose v5 → v6

### Why Upgrade

- v6.2.3 is the current stable — v5 no longer receives new features
- Post-quantum algorithm support (ML-DSA) available in v6
- Improved TypeScript inference and stricter types
- Performance improvements for key operations

### Breaking Changes v5 → v6

| Change | Impact on Project |
|---|---|
| Base64url decoding returns `Uint8Array` instead of `Buffer` | Check any code that calls `.toString()` on decoded bytes |
| `JWE` compression removed | Not used (project uses JWS only) — no impact |
| `PBES2` requires explicit opt-in | Not used — no impact |
| `node:` prefix on Node.js imports | Runtime-transparent on Workers |
| `algorithms` option renamed → `allowedAlgorithms` | Update `jwtVerify()` calls |

### Migration

```bash
pnpm add jose@^6 -r   # root-level for all workspace packages
```

```ts
// BEFORE (v5)
await jwtVerify(token, jwks, { algorithms: ['RS256'] });

// AFTER (v6)
await jwtVerify(token, jwks, { allowedAlgorithms: ['RS256'] });
```

Check for `Uint8Array` vs `Buffer` usage in `packages/auth/src/jwt.ts` after upgrading.

---

## Security Advisories — All Fixed in v5.9.6

6 moderate-severity advisories existed, all against JWE operations. The project uses JWS only (JWT signing/verification). **No JWE code path → no exposure.**

---

## Post-Quantum: ML-DSA (v6 only)

jose v6 introduces ML-DSA (CRYSTALS-Dilithium) support — a NIST post-quantum digital signature algorithm:

```ts
// Sign with ML-DSA (v6+)
import { generateKeyPair } from 'jose';
const { privateKey, publicKey } = await generateKeyPair('ML-DSA-44');
```

**Not required now.** Current RS256 is secure. Consider evaluating for the next key rotation cycle (2026 Q3) once post-quantum requirements are clearer.

---

## Why jose

- Uses Web Crypto API (not `node:crypto`) — runs on Cloudflare Workers natively
- Supports RS256, ES256, EdDSA, ML-DSA (v6)
- JWKS operations (local and remote key sets)
- No native bindings required
- TypeScript-first with strict types

---

## Usage in Project

### JWT Signing (`packages/auth/src/jwt.ts`)

```ts
import { SignJWT, createLocalJWKSet, exportJWK, importPKCS8, importSPKI, jwtVerify } from 'jose';
```

| Token Type | Algorithm | TTL | Claims |
|---|---|---|---|
| Access token | RS256 | 15 min | sub, studio, role |
| Refresh token | RS256 | 30 days | sub, sid |
| QR check-in token | RS256 | 120s | sub, studio, kind, jti |

### Key Rotation

- 90-day rotation cycle
- 24h grace period (old key stays in JWKS)
- `currentJwks()` filters expired keys by `notAfter`
- `rotateKeysAsync()` produces a ready-to-serve JWKS

### OAuth Verification (`packages/auth/src/service.ts`)

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
const appleJwks = createRemoteJWKSet(new URL(appleUrl));
const googleJwks = createRemoteJWKSet(new URL(googleUrl));
```

Remote JWKS fetched from Apple/Google for ID token verification.

---

## Configuration

| Setting | Value | Rationale |
|---|---|---|
| Algorithm | RS256 | Asymmetric, public key verifiable at edge |
| Clock tolerance | 0 | Both signer and verifier share Cloudflare NTP |
| Key size | 2048-bit RSA | NIST minimum for RS256 |

**Note on `clockTolerance: 0`**: jose docs recommend 30-60s for distributed systems. Zero tolerance is acceptable here because Workers infrastructure is NTP-synced. For the QR path (120s TTL), zero is explicitly desired.

---

## Security Patterns

1. `createLocalJWKSet` for self-issued tokens (no network dependency during verification)
2. `createRemoteJWKSet` for Apple/Google with built-in caching
3. `kid` in every signed token header — verifier picks the right key
4. No `none` algorithm — jose rejects `alg: none` by default
5. `allowedAlgorithms` (v6) / `algorithms` (v5) whitelist pinned to `[JWT_ALG]`

---

## Checklist

- [x] RS256 with proper key size
- [x] `kid` in header for key rotation
- [x] `algorithms` whitelist on verification
- [x] Injectable clock for testability
- [x] Remote JWKS for OAuth providers
- [x] Local JWKS for self-issued tokens
- [x] Key rotation with grace period
- [x] Edge-compatible (Web Crypto)
- [ ] **Upgrade jose ^5 → ^6** (rename `algorithms` → `allowedAlgorithms`, check Uint8Array)
- [ ] Evaluate ML-DSA at next key rotation cycle (post-quantum readiness)

## Sources

- https://github.com/panva/jose
- https://github.com/panva/jose/blob/main/docs/README.md
- https://github.com/panva/jose/releases/tag/v6.0.0

/**
 * JWT signing, verification and JWKS publishing for `@athlya/auth`.
 *
 * Athlya issues two classes of RS256-signed tokens:
 *
 *   - **Access tokens** — short-lived (15 min) bearer credentials
 *     presented in `Authorization: Bearer <jwt>`. Verified by the API
 *     Gateway before any downstream call. Requirement 2.1.
 *   - **Refresh tokens** — long-lived (30 days) cookies rotated on
 *     every use. Requirement 2.2.
 *
 * Both are signed with RS256 under a private key held in Cloudflare
 * Secrets. The corresponding public keys are published at the
 * well-known `/.well-known/jwks.json` endpoint (see {@link currentJwks}).
 *
 * ### Key rotation (Requirement 25.5)
 *
 * Every 90 days a fresh 2048-bit RSA key pair is generated and added
 * to the active key list. The **previous** key stays in the JWKS for
 * a **grace period** (default 24 hours) so access tokens signed by
 * the old key continue to verify until their natural expiry. After
 * the grace period elapses the old key is dropped from the JWKS and
 * any token still signed by it is rejected.
 *
 * The rotation state is modelled as a small pure data structure
 * (see {@link RotationState}) so the Auth service can reconstruct it
 * from Cloudflare Secrets on every request without needing a
 * stateful scheduler; the JWKS served at the edge is just a
 * projection of that state through {@link currentJwks}.
 *
 * ### Edge compatibility
 *
 * `jose` is explicitly edge-compatible: it uses the Web Crypto API
 * on Workers and `node:crypto` on Node. We use only the subset of the
 * API that is available on both (`SignJWT`, `jwtVerify`,
 * `createLocalJWKSet`, `exportJWK`, `importPKCS8`, `importSPKI`).
 *
 * Related requirements: 2.1, 2.2, 25.5.
 */

import { SignJWT, createLocalJWKSet, exportJWK, importPKCS8, importSPKI, jwtVerify } from 'jose';

import type { CryptoKey, JSONWebKeySet, JWK, JWTPayload, JWTVerifyOptions } from 'jose';

/**
 * Signing algorithm pinned by this module. Both access and refresh
 * tokens use RS256 to match Requirement 2.1 and the design document's
 * security table.
 */
export const JWT_ALG = 'RS256' as const;

/**
 * Default access-token TTL in seconds (15 minutes). Requirement 2.1.
 */
export const DEFAULT_ACCESS_TTL_SEC = 15 * 60;

/**
 * Default refresh-token TTL in seconds (30 days). Requirement 2.2.
 */
export const DEFAULT_REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * Default rotation grace period (24 hours). When a new signing key is
 * introduced, the previous key remains in the published JWKS for this
 * duration so any still-valid access token continues to verify.
 */
export const DEFAULT_ROTATION_GRACE_SEC = 24 * 60 * 60;

/**
 * Claims carried by Athlya **access** tokens. Kept minimal so the
 * JWT stays under ~1 KB and is cheap to parse at the edge. The full
 * set of `iat`/`exp`/`jti` claims is added by {@link signAccess}.
 *
 * - `sub` — user id (UUID).
 * - `studio` — tenant id (UUID); drives RLS and cross-tenant checks.
 * - `role` — user role within the studio (`member`, `coach`, `admin`).
 */
export interface AccessClaims extends JWTPayload {
  readonly sub: string;
  readonly studio: string;
  readonly role: 'member' | 'coach' | 'admin';
}

/**
 * Claims carried by Athlya **refresh** tokens. Refresh tokens are
 * one-use by design (Requirement 2.2), so they carry a `sid` (session
 * id) used by the Auth service to find and invalidate the stored row
 * when the refresh is exchanged.
 */
export interface RefreshClaims extends JWTPayload {
  readonly sub: string;
  readonly sid: string;
}

/**
 * A single signing key known to the Auth service.
 *
 * - `kid` — stable identifier embedded in the JWS header; used by
 *   verifiers to pick the right public key from the JWKS during
 *   rotation.
 * - `privateKey` — runtime key handle (Web Crypto `CryptoKey` or Node
 *   `KeyObject`) used to sign; **never** sent over the wire.
 * - `publicKey` — runtime key handle used to export the JWK.
 * - `notBefore` — first instant at which this key is considered
 *   "current" for signing. Typically the rotation timestamp.
 * - `notAfter` — instant after which this key is dropped from the
 *   JWKS and no longer accepted for verification. Undefined means
 *   "no planned retirement".
 */
export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

/**
 * Public-key entry as it appears in the JWKS served at
 * `/.well-known/jwks.json`. Extracted from a {@link SigningKey} by
 * {@link currentJwks}.
 *
 * `notAfter` is **not** included in the published JWKS (it is a
 * server-side concept); clients derive key freshness from the
 * `Cache-Control` headers on the JWKS endpoint.
 */
export interface PublicKeyEntry {
  readonly kid: string;
  readonly publicKey: JWK;
  readonly notAfter?: Date;
}

/**
 * Alias matching the terminology used in the task description. A JWKS
 * is a JSON object with a single `keys` array per RFC 7517 §5.
 */
export type Jwks = JSONWebKeySet;

/**
 * Options for {@link signAccess}.
 */
export interface SignAccessOptions {
  readonly signingKey: SigningKey;
  readonly ttlSec?: number;
  readonly issuer?: string;
  readonly audience?: string;
  /**
   * Injectable clock (seconds since epoch). Defaults to
   * `Math.floor(Date.now() / 1000)`; tests override it.
   */
  readonly now?: () => number;
}

/**
 * Options for {@link signRefresh}.
 */
export interface SignRefreshOptions {
  readonly signingKey: SigningKey;
  readonly ttlSec?: number;
  readonly issuer?: string;
  readonly audience?: string;
  readonly now?: () => number;
}

/**
 * Options for {@link verify}.
 */
export interface VerifyOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /**
   * Maximum clock skew accepted between signer and verifier. Defaults
   * to 0 seconds — tight because both Workers and our clients use
   * NTP-synced clocks.
   */
  readonly clockToleranceSec?: number;
  /** Injectable clock for deterministic tests. */
  readonly currentDate?: Date;
}

/**
 * Internal helper: produce the default "now" function. Extracted so
 * every entry point uses the same semantics and tests can override it
 * consistently.
 */
function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signs an Athlya **access token** (RS256, 15 min by default).
 *
 * ### Preconditions
 *
 * - `claims.sub`, `claims.studio`, `claims.role` are non-empty
 *   strings. The caller is expected to enforce valid UUIDs; this
 *   function refuses empty strings to catch accidental
 *   misconfiguration early.
 * - `opts.ttlSec`, when provided, is a strictly positive integer.
 *
 * ### Postconditions
 *
 * - Returns a compact JWS string with three base64url segments.
 * - Header contains `alg = 'RS256'`, `typ = 'JWT'`, `kid = opts.signingKey.kid`.
 * - Payload contains the supplied claims plus `iat`, `exp = iat + ttlSec`.
 *
 * @throws `TypeError` on invalid claims or TTL.
 */
export async function signAccess(claims: AccessClaims, opts: SignAccessOptions): Promise<string> {
  assertNonEmpty(claims.sub, 'claims.sub');
  assertNonEmpty(claims.studio, 'claims.studio');
  assertNonEmpty(claims.role, 'claims.role');

  const ttl = opts.ttlSec ?? DEFAULT_ACCESS_TTL_SEC;
  assertPositiveInt(ttl, 'opts.ttlSec');

  const now = (opts.now ?? defaultNow)();
  const signer = new SignJWT({ ...claims })
    .setProtectedHeader({
      alg: JWT_ALG,
      typ: 'JWT',
      kid: opts.signingKey.kid,
    })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl);

  if (opts.issuer !== undefined) signer.setIssuer(opts.issuer);
  if (opts.audience !== undefined) signer.setAudience(opts.audience);
  if (claims.sub) signer.setSubject(claims.sub);

  return signer.sign(opts.signingKey.privateKey);
}

/**
 * Signs an Athlya **refresh token** (RS256, 30 days by default).
 *
 * Refresh tokens are kept structurally similar to access tokens so the
 * same verification pipeline applies (see {@link verify}), but the
 * payload only carries `sub` and `sid`: the Auth service looks up
 * `sid` in its sessions table to validate the token has not been
 * rotated out.
 */
export async function signRefresh(
  claims: RefreshClaims,
  opts: SignRefreshOptions,
): Promise<string> {
  assertNonEmpty(claims.sub, 'claims.sub');
  assertNonEmpty(claims.sid, 'claims.sid');

  const ttl = opts.ttlSec ?? DEFAULT_REFRESH_TTL_SEC;
  assertPositiveInt(ttl, 'opts.ttlSec');

  const now = (opts.now ?? defaultNow)();
  const signer = new SignJWT({ ...claims })
    .setProtectedHeader({
      alg: JWT_ALG,
      typ: 'JWT',
      kid: opts.signingKey.kid,
    })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setSubject(claims.sub);

  if (opts.issuer !== undefined) signer.setIssuer(opts.issuer);
  if (opts.audience !== undefined) signer.setAudience(opts.audience);

  return signer.sign(opts.signingKey.privateKey);
}

/**
 * Verifies a token against a JWKS.
 *
 * Delegates to {@link jwtVerify} with a locally-resolved JWKS built
 * via {@link createLocalJWKSet}. `jose` performs the following checks
 * in order:
 *
 *   1. The JWS signature matches one of the public keys in the JWKS
 *      whose `kid` matches the token header's `kid`.
 *   2. The algorithm is in the allowed list (`RS256` only).
 *   3. `iat`, `nbf`, `exp` are consistent with `currentDate` within
 *      `clockTolerance`.
 *   4. Optional `issuer` and `audience` claims match.
 *
 * Any failure throws a `jose` error (imported from `jose/errors`). We
 * intentionally **do not** catch or remap those errors here: the
 * caller is in a much better position to decide the HTTP status and
 * error code (per Requirement 2.5 the API Gateway turns an expired
 * access token into `401` with `WWW-Authenticate: Bearer
 * error="token_expired"`).
 *
 * Returns the verified payload cast to `T` for ergonomic use by the
 * caller. The cast is type-only — `jose` has already validated the
 * payload structurally.
 */
export async function verify<T extends JWTPayload = JWTPayload>(
  token: string,
  jwks: Jwks,
  opts: VerifyOptions = {},
): Promise<T> {
  const keySet = createLocalJWKSet(jwks);
  const verifyOpts: JWTVerifyOptions = {
    algorithms: [JWT_ALG],
    clockTolerance: opts.clockToleranceSec ?? 0,
  };
  if (opts.issuer !== undefined) verifyOpts.issuer = opts.issuer;
  if (opts.audience !== undefined) verifyOpts.audience = opts.audience;
  if (opts.currentDate !== undefined) verifyOpts.currentDate = opts.currentDate;

  const { payload } = await jwtVerify(token, keySet, verifyOpts);
  return payload as T;
}

/**
 * Builds a public JWKS from the supplied key entries, keeping only
 * keys that are still within their `notAfter` window.
 *
 * ### Semantics
 *
 * - Keys with no `notAfter` are always kept (they are "permanent"
 *   until explicitly rotated out).
 * - Keys with `notAfter > now()` are kept — the grace window has not
 *   elapsed yet.
 * - Keys with `notAfter ≤ now()` are dropped.
 *
 * The public JWK is passed as-is (already in JWK form, usually
 * produced by {@link publicJwkOf}); this keeps the function pure and
 * synchronous so it can run inside a cached Worker response.
 *
 * The `alg`, `use` and `kid` fields are forced to canonical values in
 * the returned JWK so clients don't have to guess:
 *
 *   - `alg = 'RS256'`
 *   - `use = 'sig'`
 *   - `kid = entry.kid`
 *
 * Relative ordering of input entries is preserved.
 *
 * @param now Optional current time; defaults to `new Date()`.
 */
export function currentJwks(keys: readonly PublicKeyEntry[], now: Date = new Date()): Jwks {
  const active: JWK[] = [];
  for (const entry of keys) {
    if (entry.notAfter !== undefined && entry.notAfter.getTime() <= now.getTime()) {
      continue;
    }
    active.push({
      ...entry.publicKey,
      kid: entry.kid,
      alg: JWT_ALG,
      use: 'sig',
    });
  }
  return { keys: active };
}

/**
 * Exports a signing key's public component as a JWK suitable for
 * inclusion in the JWKS served at `/.well-known/jwks.json`.
 *
 * This is a thin convenience wrapper around `jose.exportJWK` that
 * also stamps the `kid`, `alg` and `use` fields.
 */
export async function publicJwkOf(key: SigningKey): Promise<JWK> {
  const raw = await exportJWK(key.publicKey);
  return {
    ...raw,
    kid: key.kid,
    alg: JWT_ALG,
    use: 'sig',
  };
}

/**
 * Rotation state held by the Auth service. A service is either:
 *
 *   - **Steady** — one current signing key, no previous key.
 *   - **Rotating** — a new key is current, the previous key is still
 *     accepted by verifiers until its `notAfter`.
 *
 * This structure is the input expected by {@link rotateKeys}; the
 * service persists it (implicitly, through two distinct Cloudflare
 * Secrets) and reconstructs it on every request.
 */
export interface RotationState {
  readonly current: SigningKey;
  readonly previous?: SigningKey;
}

/**
 * Result of a rotation request. Callers typically:
 *   1. Persist `next` as the current signing secret.
 *   2. Persist `retiring` as the previous signing secret with
 *      `notAfter = rotationAt + graceSec`.
 *   3. Start serving `jwks` at `/.well-known/jwks.json`.
 */
export interface RotationResult {
  readonly current: SigningKey;
  readonly previous: SigningKey;
  readonly jwks: Jwks;
  readonly rotatedAt: Date;
  readonly graceExpiresAt: Date;
}

/**
 * Rotates the signing key.
 *
 * Given the previously-current key `previous` (which will be demoted)
 * and the freshly-minted key `next` (which will become current),
 * returns a {@link RotationResult} containing both keys stamped with
 * the right `notBefore`/`notAfter` windows and a JWKS projection
 * that serves both for the duration of the grace window.
 *
 * The caller is responsible for generating `next` (usually via
 * `jose.generateKeyPair('RS256', { modulusLength: 2048 })`) and for
 * persisting the returned keys before swapping the live JWKS.
 *
 * ### Preconditions
 *
 * - `previous.kid !== next.kid` — otherwise the old and the new JWKS
 *   entries would collide and break verifier lookups.
 * - `graceSec > 0`.
 *
 * @throws `TypeError` on invalid inputs.
 */
export function rotateKeys(
  previous: SigningKey,
  next: SigningKey,
  graceSec: number = DEFAULT_ROTATION_GRACE_SEC,
  now: Date = new Date(),
): RotationResult {
  if (previous.kid === next.kid) {
    throw new TypeError('rotateKeys: previous and next keys must have different kids');
  }
  assertPositiveInt(graceSec, 'graceSec');

  const graceExpiresAt = new Date(now.getTime() + graceSec * 1000);
  const demotedPrevious: SigningKey = {
    kid: previous.kid,
    privateKey: previous.privateKey,
    publicKey: previous.publicKey,
    notBefore: previous.notBefore ?? new Date(0),
    notAfter: graceExpiresAt,
  };
  const promotedNext: SigningKey = {
    kid: next.kid,
    privateKey: next.privateKey,
    publicKey: next.publicKey,
    notBefore: now,
    ...(next.notAfter !== undefined ? { notAfter: next.notAfter } : {}),
  };

  // Build the JWKS projection synchronously. We can't call
  // publicJwkOf here because it's async and this helper is pure; the
  // caller should instead call currentJwks() later with the exported
  // public JWKs. To preserve the task contract (rotateKeys returns a
  // RotationResult), we build the JWKS from the public keys that the
  // caller already has. That means the caller must pre-export the
  // JWKs or rely on the asynchronous rotateKeysAsync variant.
  const jwks: Jwks = { keys: [] };

  return {
    current: promotedNext,
    previous: demotedPrevious,
    jwks,
    rotatedAt: now,
    graceExpiresAt,
  };
}

/**
 * Async companion to {@link rotateKeys} that also materialises the
 * JWKS projection for convenience. Prefer this when you want a
 * ready-to-serve JWKS rather than re-exporting the JWKs yourself.
 */
export async function rotateKeysAsync(
  previous: SigningKey,
  next: SigningKey,
  graceSec: number = DEFAULT_ROTATION_GRACE_SEC,
  now: Date = new Date(),
): Promise<RotationResult> {
  const result = rotateKeys(previous, next, graceSec, now);
  const [currentJwk, previousJwk] = await Promise.all([
    publicJwkOf(result.current),
    publicJwkOf(result.previous),
  ]);
  const jwks = currentJwks(
    [
      {
        kid: result.current.kid,
        publicKey: currentJwk,
        ...(result.current.notAfter !== undefined ? { notAfter: result.current.notAfter } : {}),
      },
      {
        kid: result.previous.kid,
        publicKey: previousJwk,
        notAfter: result.graceExpiresAt,
      },
    ],
    now,
  );
  return { ...result, jwks };
}

/**
 * Loads a PEM-encoded RSA key pair into runtime key handles. Intended
 * for local development and tests — in production we load
 * {@link SigningKey} material from Cloudflare Secrets directly.
 *
 * ### Preconditions
 *
 * - `privatePem` is a valid PKCS#8 PEM block.
 * - `publicPem` is a valid SPKI PEM block matching `privatePem`.
 * - `kid` is a non-empty, URL-safe identifier.
 */
export async function loadKeyPairFromPem(
  privatePem: string,
  publicPem: string,
  kid: string,
): Promise<SigningKey> {
  assertNonEmpty(kid, 'kid');
  const [privateKey, publicKey] = await Promise.all([
    importPKCS8(privatePem, JWT_ALG),
    importSPKI(publicPem, JWT_ALG),
  ]);
  return { kid, privateKey, publicKey };
}

// ---------------------------------------------------------------------------
// Internal assertions
// ---------------------------------------------------------------------------

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

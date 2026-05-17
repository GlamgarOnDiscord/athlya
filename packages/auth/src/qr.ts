/**
 * QR check-in token generation and verification for `@athlya/auth`.
 *
 * Athlya members check in at a studio by presenting a short-lived QR
 * code — a distinct flavour of JWT with its own lifecycle and its own
 * replay-prevention window. This module is the canonical implementation
 * of that token; the Mobile_App mints it ({@link generateAccessQR}) and
 * the Reservations_Service verifies it ({@link verifyAccessQR}).
 *
 * The claims we commit to on every token:
 *
 *   - `sub`   — the member's user id.
 *   - `studio` — the tenant id the token is scoped to. Must match the
 *     studio running the check-in terminal; cross-tenant tokens are
 *     rejected.
 *   - `kind`  — the literal string `'checkin'`. Used to disambiguate
 *     QR tokens from access tokens signed by the same key pair.
 *   - `iat`   — issued-at timestamp in seconds.
 *   - `exp`   — `iat + 120`. TTL is pinned at **120 seconds**
 *     per Requirement 11.1.
 *   - `jti`   — a fresh UUID v4. Consumed exactly once via
 *     {@link ReplayStore} so a leaked or photographed QR cannot be
 *     rescanned within its validity window (Requirement 11.4, 11.5).
 *
 * The verification pipeline below checks these in the order mandated
 * by Requirement 11.2:
 *
 *   1. JWS signature + `exp`/`iat` time window (via `jose.jwtVerify`).
 *   2. `kind === 'checkin'`.
 *   3. `studio === expectedStudioId`.
 *   4. `jti` not already in the replay store.
 *
 * Only after all four pass do we record the `jti` so that any
 * subsequent presentation is rejected with {@link QRReplayError}. The
 * strict ordering is important: signature first means a forged token
 * never pollutes the replay set, which would otherwise be a cheap DoS
 * vector.
 *
 * Related requirements: 11.1, 11.2, 11.3, 11.4, 11.5.
 */

import { SignJWT, createLocalJWKSet, jwtVerify } from 'jose';

import { JWT_ALG } from './jwt.js';

import type { Jwks, SigningKey } from './jwt.js';
import type { JWTPayload } from 'jose';

/**
 * TTL of a QR check-in token in seconds. Pinned at 120 s per
 * Requirement 11.1; raising or lowering this would be a cross-cutting
 * change (studio hardware timing, mobile cache, replay window) and is
 * intentionally not exposed as an option.
 */
export const QR_TTL_SEC = 120;

/**
 * Claims carried by a QR check-in token, in the shape committed to in
 * {@link generateAccessQR} and decoded in {@link verifyAccessQR}.
 *
 * `iat` and `exp` are Unix seconds, matching the JWT spec.
 */
export interface QRCheckinClaims extends JWTPayload {
  readonly sub: string;
  readonly studio: string;
  readonly kind: 'checkin';
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

/**
 * Abstraction over the replay-prevention store that backs
 * Requirement 11.4/11.5. Production uses the Upstash-Redis-backed
 * adapter in `./replay-redis.js`; tests use an in-memory `Map`.
 *
 * The store has exactly two operations:
 *
 *   - `has(jti)` — `true` iff `jti` has already been consumed within
 *     its validity window.
 *   - `add(jti, ttlSec)` — record `jti` with a TTL matching the token's
 *     remaining lifetime. After `ttlSec` seconds the entry is purged
 *     and the `jti` may be minted again by the signer (which it
 *     never is in practice — each token has a fresh UUID v4).
 *
 * Both operations are `async` so the interface is uniform across the
 * Redis adapter (network I/O) and the in-memory adapter (synchronous).
 */
export interface ReplayStore {
  has(jti: string): Promise<boolean>;
  add(jti: string, ttlSec: number): Promise<void>;
}

/**
 * Reason codes attached to {@link InvalidQRTokenError}. Matched
 * 1:1 against the HTTP error codes the API Gateway emits in the
 * `application/problem+json` envelope, which is in turn wired to
 * Requirement 11.3.
 */
export type InvalidQRTokenReason = 'invalid_token';

/**
 * Thrown when the QR token fails any of signature verification, time
 * window, `kind`, or `studio` scope checks. Carries a stable
 * `code = 'invalid_token'` so the API Gateway can serialize a Problem
 * Details payload without branching on message text.
 *
 * The originating `jose` error (if any) is propagated via the standard
 * `cause` property so logs retain the underlying stack.
 */
export class InvalidQRTokenError extends Error {
  public override readonly name = 'InvalidQRTokenError';
  public readonly code: InvalidQRTokenReason;

  public constructor(code: InvalidQRTokenReason, options?: { cause?: unknown }) {
    super(`QR token rejected: ${code}`, options);
    this.code = code;
  }
}

/**
 * Thrown when a QR token is cryptographically valid but its `jti` has
 * already been consumed — i.e. the token is being replayed.
 * Requirement 11.5 maps this to HTTP 401 `replay`.
 */
export class QRReplayError extends Error {
  public override readonly name = 'QRReplayError';
  public readonly code = 'replay' as const;

  public constructor() {
    super('QR token rejected: replay');
  }
}

/**
 * Options accepted by {@link generateAccessQR}.
 */
export interface GenerateAccessQROptions {
  readonly signingKey: SigningKey;
  /**
   * Injectable clock (seconds since epoch). Defaults to
   * `Math.floor(Date.now() / 1000)`; tests override it.
   */
  readonly now?: () => number;
  /**
   * Injectable `jti` source, default `crypto.randomUUID()`. Tests
   * pin this to a deterministic UUID so they can assert replay
   * rejection.
   */
  readonly jti?: () => string;
}

/**
 * Options accepted by {@link verifyAccessQR}.
 */
export interface VerifyAccessQROptions {
  readonly jwks: Jwks;
  readonly replayStore: ReplayStore;
  /**
   * Injectable clock (seconds since epoch). Defaults to
   * `Math.floor(Date.now() / 1000)`. Only used to compute the TTL
   * passed to {@link ReplayStore.add}; the signature/exp checks use
   * `jose`'s own clock with zero tolerance (see below).
   */
  readonly now?: () => number;
}

/**
 * Verified output returned by {@link verifyAccessQR} on success. The
 * caller (Reservations_Service check-in handler) uses `userId` +
 * `studioId` to locate the relevant reservation and stamp
 * `checked_in_at = now()` (Requirement 11.6).
 */
export interface VerifiedQRToken {
  readonly userId: string;
  readonly studioId: string;
  readonly jti: string;
}

/**
 * Default clock. Extracted so sign and verify paths share the exact
 * same semantics and tests can override them uniformly.
 */
function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Generates a fresh QR check-in token.
 *
 * ### Preconditions
 *
 * - `userId` and `studioId` are non-empty strings. The caller is
 *   expected to pass proper UUIDs; we reject empty strings to catch
 *   accidental misconfiguration early.
 * - `opts.signingKey.privateKey` is an RS256 private key.
 *
 * ### Postconditions
 *
 * - Returns a compact JWS whose payload exactly matches
 *   {@link QRCheckinClaims}.
 * - `exp - iat === 120` seconds.
 * - The token header carries `alg = 'RS256'`, `typ = 'JWT'`,
 *   `kid = opts.signingKey.kid`.
 *
 * @throws `TypeError` on invalid inputs.
 */
export async function generateAccessQR(
  userId: string,
  studioId: string,
  opts: GenerateAccessQROptions,
): Promise<string> {
  assertNonEmpty(userId, 'userId');
  assertNonEmpty(studioId, 'studioId');

  const now = (opts.now ?? defaultNow)();
  const iat = now;
  const exp = now + QR_TTL_SEC;
  const jti = (opts.jti ?? (() => crypto.randomUUID()))();
  assertNonEmpty(jti, 'opts.jti()');

  const payload: QRCheckinClaims = {
    sub: userId,
    studio: studioId,
    kind: 'checkin',
    iat,
    exp,
    jti,
  };

  return new SignJWT({ ...payload })
    .setProtectedHeader({
      alg: JWT_ALG,
      typ: 'JWT',
      kid: opts.signingKey.kid,
    })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setSubject(userId)
    .setJti(jti)
    .sign(opts.signingKey.privateKey);
}

/**
 * Verifies a QR check-in token.
 *
 * Checks run in a fixed, security-sensitive order (Requirement 11.2):
 *
 *   1. JWS signature + `exp`/`iat` time window via `jose.jwtVerify`
 *      with `clockTolerance = 0`. On any failure this step throws
 *      {@link InvalidQRTokenError} with `code = 'invalid_token'`,
 *      preserving the underlying jose error as `cause`.
 *   2. `payload.kind === 'checkin'` — rejects access/refresh tokens
 *      that happen to be signed by the same key pair.
 *   3. `payload.studio === expectedStudioId` — rejects tokens from
 *      another studio being presented at this studio's terminal.
 *   4. `payload.jti` is a non-empty string and not already in the
 *      replay store; on hit {@link QRReplayError} is thrown
 *      (Requirement 11.5).
 *
 * Only after all four succeed is `jti` recorded in the replay store
 * (Requirement 11.4) with a TTL equal to the token's remaining
 * lifetime (floored to at least 1 s). This keeps the replay memory
 * O(active-QRs) and auto-purges after `exp`.
 *
 * @throws {@link InvalidQRTokenError} on any signature/payload/window failure.
 * @throws {@link QRReplayError} if `jti` has already been consumed.
 */
export async function verifyAccessQR(
  token: string,
  expectedStudioId: string,
  opts: VerifyAccessQROptions,
): Promise<VerifiedQRToken> {
  assertNonEmpty(expectedStudioId, 'expectedStudioId');

  // Step 1 — signature + standard time window. jose handles `iat`,
  // `exp`, and algorithm pinning; clockTolerance = 0 is required
  // because the QR window is only 120 seconds and we don't want to
  // tolerate any drift (Req 11.2).
  let payload: JWTPayload;
  try {
    const keySet = createLocalJWKSet(opts.jwks);
    const result = await jwtVerify(token, keySet, {
      algorithms: [JWT_ALG],
      clockTolerance: 0,
      ...(opts.now !== undefined ? { currentDate: new Date(opts.now() * 1000) } : {}),
    });
    payload = result.payload;
  } catch (cause) {
    throw new InvalidQRTokenError('invalid_token', { cause });
  }

  // Step 2 — `kind`. We deliberately compare against the literal
  // string so a malicious payload with `kind: ['checkin']` or similar
  // exotic shape falls through to the reject branch.
  if (payload['kind'] !== 'checkin') {
    throw new InvalidQRTokenError('invalid_token');
  }

  // Step 3 — studio scope.
  if (payload['studio'] !== expectedStudioId) {
    throw new InvalidQRTokenError('invalid_token');
  }

  // Step 4 — replay. `jti` must be a syntactically-valid non-empty
  // string before we consult the store: bogus types would otherwise
  // short-circuit the replay set (an empty-string `jti` could be
  // shared by many tokens).
  const jti = payload.jti;
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new InvalidQRTokenError('invalid_token');
  }

  const seen = await opts.replayStore.has(jti);
  if (seen) {
    throw new QRReplayError();
  }

  // Record the jti for its remaining lifetime. `exp` is guaranteed
  // present by jose (it verified it above); we defensively guard
  // against missing `exp` just to satisfy the type system.
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
  const now = (opts.now ?? defaultNow)();
  const remainingTtl = exp !== undefined ? exp - now : QR_TTL_SEC;
  const ttlSec = Math.max(1, Math.floor(remainingTtl));
  await opts.replayStore.add(jti, ttlSec);

  // Narrowed return — the caller only needs these three pieces of
  // information, so we don't leak the rest of the JWT payload.
  const userId = typeof payload.sub === 'string' ? payload.sub : '';
  if (userId.length === 0) {
    // sub is mandatory in our generator; missing sub is a malformed
    // token. Same failure mode as step 4.
    throw new InvalidQRTokenError('invalid_token');
  }
  return { userId, studioId: expectedStudioId, jti };
}

// ---------------------------------------------------------------------------
// Internal assertions
// ---------------------------------------------------------------------------

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/**
 * Login-attempt sliding-window throttle for `@athlya/auth`.
 *
 * Implements Requirement 1.6:
 *
 *   > IF more than 5 failed login attempts are observed for the same
 *   > (IP, email) pair within a 15-minute sliding window, THEN THE
 *   > Auth_Service SHALL reject further login attempts with HTTP 429
 *   > and a `Retry-After` header until the window expires.
 *
 * The throttle is a thin wrapper over
 * {@link rateLimitSlidingWindow} from `@athlya/ratelimit`: we reuse
 * the same sorted-set algorithm so its exactness property (P8) extends
 * here for free. The only logic local to this module is:
 *
 *   1. **Normalization** of the `email` component of the bucket key.
 *      Requirement 1.6 is keyed on "the same (IP, email) pair", so two
 *      attempts differing only in email case (`Alice@Ex.com` vs
 *      `alice@ex.com`) must collide into the same bucket. We lower-case
 *      and trim; the API Gateway is expected to have already performed
 *      Zod email validation upstream, so we do not re-validate here.
 *   2. **Key construction** under a stable `auth:login:` prefix so the
 *      Upstash database can be shared with other limiters (IP-global,
 *      per-user) without collisions.
 *   3. **Adapting the limiter's discriminated union** into the simple
 *      `LoginThrottleDecision` shape that the Auth service will hand
 *      back to the API Gateway. The gateway uses `allow` + `remaining`
 *      to populate `X-RateLimit-Remaining` and `retryAfterSec` to
 *      populate the `Retry-After` header per RFC 6585.
 *
 * ### Why this lives here, not in `@athlya/ratelimit`
 *
 * The per-endpoint policy (limit, window, key shape) is an Auth-domain
 * concern: the IP+email pair is login-specific and the 5 / 15 min
 * budget is defined in Requirement 1.6, not in the rate-limit layer.
 * The rate-limiter primitive (`@athlya/ratelimit`) stays generic; the
 * `shouldAllowLogin` use case composes it with policy.
 *
 * Hardening H5: the primitive used to live in `@athlya/api`, but that
 * made `@athlya/auth` depend on `@athlya/api` while `@athlya/api`'s
 * auth middleware depends back on `@athlya/auth/jwt` — a circular
 * dependency. Extracting the primitive into its own neutral package
 * breaks the cycle without changing any behaviour.
 *
 * Related requirements: 1.6, 15.1, 15.2, 15.3.
 */

import { rateLimitSlidingWindow } from '@athlya/ratelimit';

import type { Redis } from '@upstash/redis';

/**
 * Maximum number of login attempts allowed per `(IP, email)` bucket
 * inside the sliding window. Pinned by Requirement 1.6 ("more than 5
 * failed login attempts"). Exported as a named constant so the value
 * is discoverable in one place and can be referenced by tests without
 * hard-coding.
 */
export const LOGIN_ATTEMPT_LIMIT = 5;

/**
 * Sliding-window size in seconds. 15 minutes = 900 s per
 * Requirement 1.6.
 */
export const LOGIN_WINDOW_SEC = 900;

/**
 * Stable Redis key prefix for login-attempt buckets. Kept short to
 * minimise Upstash payload size (each key is part of every pipeline).
 */
export const LOGIN_BUCKET_PREFIX = 'auth:login';

/**
 * Dependencies accepted by {@link shouldAllowLogin}. Mirrors the shape
 * used elsewhere in `@athlya/auth` (see `qr.ts`, `replay-redis.ts`) so
 * callers can build a single deps bundle at Worker boot time and pass
 * it everywhere.
 */
export interface LoginThrottleDeps {
  /** Upstash Redis client, typically `Redis.fromEnv()` on the edge. */
  readonly redis: Redis;
  /**
   * Injectable clock returning milliseconds since epoch. Defaults to
   * the process clock inside the rate limiter. Exposed for tests.
   */
  readonly now?: () => number;
}

/**
 * Outcome of a login-attempt throttle check.
 *
 *   - `allow: true` → the caller may proceed to verify credentials.
 *     `remaining` is the number of additional attempts allowed before
 *     the bucket saturates. Included on allow so callers can surface
 *     `X-RateLimit-Remaining` without a second limiter call.
 *   - `allow: false` → the caller MUST return HTTP 429 and a
 *     `Retry-After` header whose value is `retryAfterSec`. The bucket
 *     is guaranteed to free at least one slot after `retryAfterSec`
 *     seconds (see the limiter's invariants).
 *
 * The two fields are mutually exclusive in practice but are kept as
 * optional on the unified shape so the Auth service can return a
 * single type without a discriminated union — the gateway only needs
 * to branch on `allow`.
 */
export interface LoginThrottleDecision {
  readonly allow: boolean;
  readonly retryAfterSec?: number;
  readonly remaining?: number;
}

/**
 * Normalizes an email for bucket-key construction.
 *
 * Requirement 1.6 is keyed on the "(IP, email) pair". Without
 * normalization, a bot could bypass the throttle by alternating the
 * case of the email argument (`A@x.com`, `a@x.com`, `A@X.COM`, ...) —
 * each distinct casing would hash to a distinct bucket. We therefore:
 *
 *   - Trim surrounding whitespace (defensive; the Zod schema should
 *     already have refused padded emails, but the throttle is the
 *     security boundary).
 *   - Lower-case the whole address. RFC 5321 makes the local part
 *     case-sensitive in principle, but in practice every production
 *     mail provider folds it; treating them as equal here matches
 *     operator expectation and removes the bypass vector.
 *   - Punycode-normalize the domain via the `URL` constructor (issue #243).
 *     Without this, homoglyph variants of an IDN domain (`café.com` vs
 *     `xn--caf-dma.com`) hash to different buckets and allow N × 5
 *     brute-force attempts per window. The `URL` API is available in
 *     all Workers and Node ≥ 20 runtimes; no external dep is needed.
 *     Falls back to the trimmed+lowercased form when the domain cannot
 *     be parsed (malformed input that upstream Zod already rejected).
 */
export function normalizeLoginEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new TypeError('shouldAllowLogin: email must be a string');
  }
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  try {
    const normalized = new URL(`https://x@${domain}`).hostname;
    return `${local}@${normalized}`;
  } catch {
    return trimmed;
  }
}

/**
 * Returns the Redis bucket key used for a given `(ip, email)` pair.
 *
 * Sprint-3 Slice 3.2 (Vague 31, audit finding S5-007) — the key is
 * now SHA-256(ip + ':' + email_normalized) truncated to 24 hex
 * chars rather than the raw IP+email tuple. The CNIL doctrine
 * "Vie Privée 4 — Authentification" recommends pseudonymisation
 * of identifiers stored in anti-abuse caches; a Redis dump that
 * leaks `auth:login:1.2.3.4:alice@example.com` exposes the
 * authentication footprint of a specific user from a specific IP,
 * which is materially worse than leaking
 * `auth:login:7c6a180b36896a0a8c02787eeafb0e4c`.
 *
 * Properties of the new key:
 *   - 24 hex chars = 96 bits of identifier — the collision
 *     probability over the 15-minute window's bucket population
 *     (millions of users × millions of IPs) is negligible (birthday
 *     bound at ~2^48).
 *   - Uniqueness preserved — same `(ip, email)` always produces the
 *     same key, so the sliding-window counter still works.
 *   - Reversal infeasible — SHA-256 has no known break for length-
 *     extension or pre-image, and the input space is sparse but not
 *     exhaustively enumerable in practice (every IPv4 × every
 *     possible email = 2^64 input pairs minimum).
 *
 * The function is async because the Web Crypto API
 * (`crypto.subtle.digest`) returns a Promise. `shouldAllowLogin` is
 * already async so the call-chain change is invisible to its
 * consumers.
 */
export async function loginBucketKey(ip: string, email: string): Promise<string> {
  assertNonEmpty(ip, 'ip');
  assertNonEmpty(email, 'email');
  const normalized = `${ip}:${normalizeLoginEmail(email)}`;
  const data = new TextEncoder().encode(normalized);
  // `globalThis.crypto.subtle` is provided by the Cloudflare
  // Workers runtime AND by Node 20 LTS (matching the .nvmrc
  // engine pin). We do not import `node:crypto` here so the
  // module stays Workers-runtime-pure.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // 24 hex chars = 96 bits — comfortable margin over collision
  // birthday bound for the throttle's window-bound population.
  return `${LOGIN_BUCKET_PREFIX}:${hex.slice(0, 24)}`;
}

/**
 * Evaluate whether a login attempt from `(ip, email)` may proceed.
 *
 * ### Preconditions
 *
 *   - `ip` is a non-empty string (the client IP the API Gateway
 *     resolved from `CF-Connecting-IP`).
 *   - `email` is a non-empty string. We do not re-validate the email
 *     shape; the Zod schema upstream has already done so.
 *   - `deps.redis` is an authenticated Upstash Redis client.
 *
 * ### Postconditions
 *
 *   - Returns `{ allow: true, remaining }` iff the number of attempts
 *     recorded in the window (including the just-added one) is ≤
 *     {@link LOGIN_ATTEMPT_LIMIT}.
 *   - Returns `{ allow: false, retryAfterSec }` otherwise, with
 *     `retryAfterSec ∈ [1, LOGIN_WINDOW_SEC]` computed from the oldest
 *     attempt in the window.
 *   - The limiter records this invocation as one attempt regardless of
 *     outcome, matching the "attempts observed" wording in
 *     Requirement 1.6.
 *
 * ### Idempotency note
 *
 * Each call to {@link shouldAllowLogin} is a failed-attempt signal;
 * the Auth service is expected to invoke it **before** bcrypt
 * verification, so the bucket counts both successful and failed
 * credentials. This matches the design's "login attempts" language,
 * which is broader than "failed attempts": it treats a successful
 * credential guess after 5 wrong ones as the sixth attempt, which is
 * the behavior we want.
 */
export async function shouldAllowLogin(
  ip: string,
  email: string,
  deps: LoginThrottleDeps,
): Promise<LoginThrottleDecision> {
  const key = await loginBucketKey(ip, email);

  const decision = await rateLimitSlidingWindow(
    deps.now !== undefined ? { redis: deps.redis, now: deps.now } : { redis: deps.redis },
    key,
    LOGIN_ATTEMPT_LIMIT,
    LOGIN_WINDOW_SEC,
  );

  if (decision.kind === 'allow') {
    return { allow: true, remaining: decision.remaining };
  }
  return { allow: false, retryAfterSec: decision.retryAfterSec };
}

// ---------------------------------------------------------------------------
// Internal assertions
// ---------------------------------------------------------------------------

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

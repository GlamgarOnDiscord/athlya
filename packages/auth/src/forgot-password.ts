/**
 * Forgot-password primitive — Sprint-6 Slice 6.3 (Vague 34, audit
 * finding S2-006 [HIGH/MEDIUM][PROD-RISK] — service-layer core).
 *
 * The audit flagged the absence of any password-reset flow as a
 * blocker before prod, especially given HIBP fail-closed: a user
 * whose chosen password is breached after the fact would be
 * permanently locked out. This module ships the SERVICE-LAYER
 * core only — the two pure use cases plus their dependency
 * contract. The remaining wiring (email transport via Resend,
 * `password_reset_tokens` migration, gateway routes
 * `POST /v1/auth/password-reset/request` + `/confirm`, UI 3-step
 * flow `/forgot-password` → email link → `/reset-password/[token]`)
 * is documented as the production-side TODO checklist below; each
 * piece composes onto the primitives exported here without further
 * domain logic.
 *
 * Security envelope
 * -----------------
 *   1. **Constant-time email enumeration defence**: `requestReset()`
 *      ALWAYS returns success to the caller, regardless of whether
 *      the email matches an active user. The email transport is
 *      the only side-effect that branches on existence — which
 *      isn't observable from the HTTP response.
 *   2. **Token entropy**: 256-bit random token via Web Crypto, base64url-
 *      encoded. Stored as SHA-256 hash so a DB leak does not
 *      enable replay (mirror of session sid storage policy).
 *   3. **Single-use**: `confirmReset()` deletes the token row in
 *      the SAME transaction as the password update. A replay
 *      after consumption hits `token_invalid`.
 *   4. **Short TTL**: default 1 hour. Audit recommends ≤ 24h; we
 *      pick 1h to align with the access-token lifetime philosophy.
 *   5. **HIBP re-check**: fail-open posture, matching `register()` (issue #233).
 *      A user choosing a breached password gets `password_breached`.
 *      When HIBP is unreachable, the reset proceeds and a
 *      `athlya.hibp.degraded` metric is emitted for alerting — a
 *      transient HIBP outage must not block account recovery.
 *   6. **Family revoke**: after a successful reset, every active
 *      session of the user is destroyed via
 *      `sessionStore.revokeAllForUser` — the assumption is that
 *      a password reset is itself a security-event signal, often
 *      triggered by suspicion of compromise.
 *
 * Production wiring TODOs (out of scope for Vague 34)
 * ---------------------------------------------------
 *   - `packages/db/migrations/0004_password_reset_tokens.sql`
 *     — table `password_reset_tokens(id uuid PK, user_id, token_hash,
 *       requested_at, expires_at, consumed_at)` + index on
 *       `token_hash` + RLS bypass for the auth service role.
 *   - `packages/api/src/adapters/password-reset-repo-drizzle.ts`
 *     — implements {@link PasswordResetRepo} below.
 *   - `packages/auth/src/service.ts` — extend `AuthServiceDeps`
 *     with `passwordResetRepo` + `emailTransport`.
 *   - `packages/api/src/routes/auth.ts` — wire two new routes
 *     `POST /v1/auth/password-reset/request` (rate-limited, 3 req
 *     per email per 24h) and `POST /v1/auth/password-reset/confirm`
 *     (same rate-limit per token).
 *   - `apps/web/src/app/forgot-password/page.tsx` + email template
 *     `apps/web/src/lib/email/password-reset.html`.
 *
 * @see docs/security/audit-S2-auth.md S2-006
 */

import { hash as hashPassword } from './password.js';
import { isBreached as defaultIsBreached, HibpUnavailableError } from './hibp.js';
import { AuthError } from './service.js';

import type { AuthServiceDeps } from './service.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Token TTL in seconds. Default: 1 hour. */
export const DEFAULT_RESET_TOKEN_TTL_SEC = 60 * 60;

/** Length in bytes of the random token before base64url encoding. */
const TOKEN_RAW_BYTES = 32; // 256-bit

/* ------------------------------------------------------------------ */
/*  Repo contract                                                      */
/* ------------------------------------------------------------------ */

/**
 * Persistence contract for password-reset tokens. The Drizzle
 * adapter shipping in the prod-wiring slice maps each method to a
 * single SQL statement. Tests stub via `vi.fn()`.
 */
export interface PasswordResetRepo {
  /**
   * Insert a new token row keyed on `tokenHash`, atomically invalidating
   * any existing active tokens for the same user first (issue #522).
   * The plain token is NEVER persisted — the repo only sees the hash.
   *
   * Implementations MUST guarantee that at most one active token exists
   * per user after this call returns, even under concurrent invocations.
   */
  insertToken(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<void>;

  /**
   * Lookup an active (un-consumed, non-expired) token by its
   * hash. Returns `null` when no row matches; the SQL filter
   * MUST be `consumed_at IS NULL AND expires_at > NOW()`.
   */
  findActiveTokenByHash(tokenHash: string): Promise<{
    readonly userId: string;
    readonly expiresAt: Date;
  } | null>;

  /**
   * Atomically (a) mark the presented token consumed, (b) invalidate
   * ALL other active tokens for the same user (sibling invalidation,
   * issue #522), and (c) update the user's password hash. All three
   * writes MUST be one atomic operation so no partial failure can leave
   * a "consumed token but old password" or "password updated but siblings
   * still valid" state.
   *
   * Throws an error (`'password_reset_token_already_consumed'`) when the
   * token was already consumed or belongs to a different user.
   */
  consumeAndResetPassword(input: {
    readonly tokenHash: string;
    readonly userId: string;
    readonly newPasswordHash: string;
  }): Promise<void>;

  /**
   * Optional rate-limit hook — the cron sweeper deletes
   * tokens whose `expires_at < now() - 30 days`. Documented
   * here for the migration to wire correctly; not invoked
   * directly by this module.
   */
  purgeExpired?(): Promise<{ readonly deleted: number }>;
}

/* ------------------------------------------------------------------ */
/*  Email transport contract                                           */
/* ------------------------------------------------------------------ */

/**
 * Side-effect surface for delivering the reset email. The audit
 * recommends Resend (already used elsewhere in the platform). We
 * keep the contract narrow so the transport stays swappable.
 */
export interface PasswordResetEmailTransport {
  /**
   * Send the reset email. The `link` already carries the plain
   * token — implementations MUST send the email AS-IS without
   * logging or persisting `link` content, because the link
   * grants a 1-hour bearer credential.
   */
  sendResetEmail(input: {
    readonly to: string;
    readonly link: string;
    readonly expiresAt: Date;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Generate a cryptographically secure random reset token. */
function generateRandomToken(): string {
  const bytes = new Uint8Array(TOKEN_RAW_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  // base64url — URL-safe, no padding so the email link looks clean.
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

/** SHA-256 + hex encode — same primitive used by the throttle key. */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ */
/*  requestReset                                                       */
/* ------------------------------------------------------------------ */

export interface RequestResetDeps {
  readonly userRepo: AuthServiceDeps['userRepo'];
  readonly passwordResetRepo: PasswordResetRepo;
  readonly emailTransport: PasswordResetEmailTransport;
  /** Base URL of the web app. Token is appended to build `link`. */
  readonly resetLinkBaseUrl: string;
  /** Optional clock injection for tests. */
  readonly now?: () => number;
  /** Optional TTL override (default 1 hour). */
  readonly tokenTtlSec?: number;
}

export interface RequestResetResult {
  /**
   * Always `'sent'` from the caller's perspective — see the
   * email-enumeration defence rationale in the module doc.
   * The actual side-effect (email dispatched) only fires when
   * a matching active user was found.
   */
  readonly kind: 'sent';
}

/**
 * Begin a password reset flow. Mints a token, persists its hash,
 * dispatches the email — all conditional on the email matching an
 * active (non-soft-deleted) user. Returns `'sent'` regardless to
 * defeat email-enumeration probes.
 */
export async function requestReset(
  email: string,
  deps: RequestResetDeps,
): Promise<RequestResetResult> {
  if (typeof email !== 'string' || email.length === 0) {
    // Validation upstream is the gateway's job. Bail to
    // `token_invalid` to keep the error surface narrow rather
    // than leaking the validation failure.
    throw new AuthError('token_invalid');
  }

  const normalized = email.trim().toLowerCase();
  const user = await deps.userRepo.findUserByEmail(normalized);

  // Branch ONLY on whether the side-effect (email) fires. The
  // returned shape is identical so the response time is also
  // similar.
  if (user !== null && user.deletedAt === null) {
    const ttlSec = deps.tokenTtlSec ?? DEFAULT_RESET_TOKEN_TTL_SEC;
    const nowMs = deps.now !== undefined ? deps.now() * 1000 : Date.now();
    const expiresAt = new Date(nowMs + ttlSec * 1000);
    const plainToken = generateRandomToken();
    const tokenHash = await sha256Hex(plainToken);

    await deps.passwordResetRepo.insertToken({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const link = `${stripTrailingSlashes(deps.resetLinkBaseUrl)}/reset-password/${plainToken}`;
    await deps.emailTransport.sendResetEmail({
      to: user.email,
      link,
      expiresAt,
    });
  }

  return { kind: 'sent' };
}

/** Linear-time trailing-slash trim (a `/\/+$/` regex backtracks quadratically). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end -= 1;
  return url.slice(0, end);
}

/* ------------------------------------------------------------------ */
/*  confirmReset                                                       */
/* ------------------------------------------------------------------ */

export interface ConfirmResetInput {
  readonly token: string;
  readonly newPassword: string;
}

export interface ConfirmResetDeps {
  readonly passwordResetRepo: PasswordResetRepo;
  readonly sessionStore: AuthServiceDeps['sessionStore'];
  /** Optional HIBP `fetch` override (mirror of register's). */
  readonly hibpFetch?: typeof fetch;
  /**
   * When `true`, a HIBP outage causes password-reset to reject with
   * `AuthError('hibp_unavailable')`. Mirrors `AuthServiceDeps.hibpFailClosed`.
   */
  readonly hibpFailClosed?: boolean;
  /** Optional clock for tests. */
  readonly now?: () => number;
}

/**
 * Consume a password-reset token and replace the user's password.
 *
 * Flow:
 *   1. Hash the presented token.
 *   2. Lookup an active row by hash. Missing → `token_invalid`.
 *   3. Expiry guard (defence-in-depth — the SQL filter already
 *      rejects expired rows but the in-memory check covers a
 *      `now()` skew between DB and Worker isolate).
 *   4. HIBP check — fail-open by default (issue #233); emit
 *      `athlya.hibp.degraded` metric on outage and proceed.
 *      When `deps.hibpFailClosed` is `true`, reject with
 *      `hibp_unavailable` (HTTP 503) instead of proceeding.
 *      Reject with `password_breached` if the password is known.
 *   5. Bcrypt the new password.
 *   6. Atomic consume + reset via the repo.
 *   7. `revokeAllForUser` — every active session destroyed.
 *      Pattern is "password reset = security event"; the user
 *      re-authenticates on every device.
 *
 * @throws {\@link AuthError} with one of `token_invalid`,
 *   `token_expired`, `password_breached`,
 *   `hibp_unavailable` (only when `deps.hibpFailClosed` is `true`).
 */
export async function confirmReset(
  input: ConfirmResetInput,
  deps: ConfirmResetDeps,
): Promise<{ readonly userId: string }> {
  if (typeof input.token !== 'string' || input.token.length === 0) {
    throw new AuthError('token_invalid');
  }
  if (typeof input.newPassword !== 'string' || input.newPassword.length === 0) {
    throw new AuthError('token_invalid');
  }

  const tokenHash = await sha256Hex(input.token);
  const found = await deps.passwordResetRepo.findActiveTokenByHash(tokenHash);
  if (found === null) {
    throw new AuthError('token_invalid');
  }

  const nowMs = deps.now !== undefined ? deps.now() * 1000 : Date.now();
  if (found.expiresAt.getTime() <= nowMs) {
    throw new AuthError('token_expired');
  }

  // Fail-open by default; pass `hibpFailClosed: true` in production.
  let breached: boolean;
  try {
    breached = await defaultIsBreached(
      input.newPassword,
      deps.hibpFetch !== undefined ? { fetch: deps.hibpFetch } : {},
    );
  } catch (err) {
    if (err instanceof HibpUnavailableError) {
      console.warn('athlya.hibp.degraded', {
        metric: 'hibp_degraded',
        degraded: true,
        op: 'confirmReset',
        error: err.message,
      });
      if (deps.hibpFailClosed === true) {
        throw new AuthError('hibp_unavailable');
      }
      breached = false;
    } else {
      throw err;
    }
  }
  if (breached) {
    throw new AuthError('password_breached');
  }

  const newPasswordHash = await hashPassword(input.newPassword);

  await deps.passwordResetRepo.consumeAndResetPassword({
    tokenHash,
    userId: found.userId,
    newPasswordHash,
  });

  // Security-event posture: tear down every active session on
  // password reset. The user re-authenticates everywhere.
  await deps.sessionStore.revokeAllForUser(found.userId);

  return { userId: found.userId };
}

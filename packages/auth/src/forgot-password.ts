/**
 * Forgot-password primitive — Sprint-6 Slice 6.3 (Vague 34, audit
 * finding S2-006 [HIGH/MEDIUM][PROD-RISK] — service-layer core).
 *
 * The audit flagged the absence of any password-reset flow as a
 * blocker before prod, especially given HIBP fail-closed: a user
 * whose chosen password is breached after the fact would be
 * permanently locked out. This module holds the domain core: the
 * request, delivery and confirm use cases plus their dependency
 * contract. Storage, transport, routes and UI compose onto it from
 * the files listed under "Where it is wired".
 *
 * Security envelope
 * -----------------
 *   1. **Email enumeration defence**: `requestReset()` ALWAYS returns
 *      success to the caller, regardless of whether the email matches
 *      an active user. It only records the request (issue #645); the
 *      token and the email are produced later by `deliverResetEmail()`
 *      from the outbox, so neither their latency nor their failures
 *      reach the HTTP response.
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
 * Where it is wired
 * -----------------
 *   - Storage: `packages/db/src/schema/password_reset_tokens.ts`,
 *     created by `packages/db/migrations/0005_password_reset_audit_anonymize.sql`,
 *     then `0029_password_reset_one_active_per_user.sql` and
 *     `0043_auth_password_reset_outbox.sql`; implemented by
 *     `packages/api/src/adapters/password-reset-repo-drizzle.ts`.
 *   - Dependencies and email transport:
 *     `packages/api/src/adapters/auth-deps.ts` and
 *     `packages/api/src/adapters/password-reset-delivery-store-redis.ts`.
 *   - Delivery from the outbox:
 *     `packages/api/src/events/password-reset-consumer.ts`.
 *   - Routes: `POST /v1/auth/password-reset/request` and
 *     `POST /v1/auth/password-reset/confirm` in
 *     `packages/api/src/routes/auth.ts` (3 requests per email per 24h).
 *   - Web: `apps/web/src/app/forgot-password/`,
 *     `apps/web/src/app/reset-password/[token]/` and the proxies in
 *     `apps/web/src/app/api/auth/password-reset/{request,confirm}/`.
 *
 * @see docs/security/audit-S2-auth.md S2-006
 */

import { isBreached as defaultIsBreached, HibpUnavailableError } from './hibp.js';
import { hash as hashPassword } from './password.js';
import { AuthError } from './service.js';

import type { AuthServiceDeps } from './service.js';

/**
 * Thrown by {@link PasswordResetRepo.consumeAndResetPassword} when the
 * token can no longer be consumed: already used (concurrent reset),
 * expired since it was looked up, or not this user's (issue #609).
 * `confirmReset` maps it to `token_expired` / `token_invalid`.
 */
export class PasswordResetTokenUnavailableError extends Error {
  public constructor() {
    super('password_reset_token_already_consumed');
    this.name = 'PasswordResetTokenUnavailableError';
  }
}

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
   * Throws {@link PasswordResetTokenUnavailableError} when the token was
   * already consumed, has expired, or belongs to a different user.
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
    /**
     * Stable key for this email (one per request). Transports that
     * support it (Resend `Idempotency-Key`) must pass it, so a retried
     * send of the same email is not delivered twice.
     */
    readonly idempotencyKey?: string;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Generate a cryptographically secure random reset token. */
function generateRandomToken(): string {
  const bytes = new Uint8Array(TOKEN_RAW_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** base64url — URL-safe, no padding so the email link looks clean. */
function toBase64Url(bytes: Uint8Array): string {
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

/**
 * Durable hand-off of a reset request (issue #645). The production
 * adapter calls `auth_request_password_reset`, which looks up the live
 * account and records an `auth.password_reset.requested` outbox row in
 * one statement; an unknown or soft-deleted address records nothing.
 * The outbox drain then delivers the event to
 * {@link deliverResetEmail}, with the queue's retry budget and DLQ.
 */
export interface PasswordResetRequestQueue {
  /** Record a reset request for `normalizedEmail`. Resolves whether or not the account exists. */
  enqueue(normalizedEmail: string): Promise<void>;
}

export interface RequestResetDeps {
  readonly resetRequests: PasswordResetRequestQueue;
}

export interface RequestResetResult {
  /**
   * Always `'sent'` from the caller's perspective — see the
   * email-enumeration defence rationale in the module doc.
   * The email itself only goes out when a matching active user
   * was found.
   */
  readonly kind: 'sent';
}

/**
 * Begin a password reset flow: normalise the address and record the
 * request. Token issuance and the email happen later, in
 * {@link deliverResetEmail}, so no account-dependent external call runs
 * on the request path (issue #521). Returns `'sent'` regardless to
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

  await deps.resetRequests.enqueue(email.trim().toLowerCase());
  return { kind: 'sent' };
}

/* ------------------------------------------------------------------ */
/*  deliverResetEmail                                                  */
/* ------------------------------------------------------------------ */

/** Outcome of {@link PasswordResetRequestTokenStore.issueForRequest}. */
export type RequestTokenIssue = 'issued' | 'superseded' | 'inactive';

/**
 * Token persistence for a recorded request. Unlike
 * {@link PasswordResetRepo.insertToken}, a retry of the same request finds
 * its own token again instead of invalidating it:
 *
 *   - `'issued'`     — stored (previous active tokens invalidated, issue
 *                      #522), or already stored for this request and still
 *                      unconsumed: its expiry is re-armed.
 *   - `'superseded'` — this request's token was consumed (used, or replaced
 *                      by a later request): nothing to send.
 *   - `'inactive'`   — the account is deleted or unknown: nothing to send.
 */
export interface PasswordResetRequestTokenStore {
  issueForRequest(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<RequestTokenIssue>;
}

/** The recorded request being delivered (the outbox event). */
export interface ResetRequest {
  /** Event id of the request; stable across retries and DLQ replays. */
  readonly requestId: string;
  readonly userId: string;
}

export interface DeliverResetDeps {
  readonly userRepo: Pick<AuthServiceDeps['userRepo'], 'findUserById'>;
  readonly tokens: PasswordResetRequestTokenStore;
  readonly emailTransport: PasswordResetEmailTransport;
  /**
   * Derive the request's token (see {@link createResetTokenDeriver}). The
   * same request always yields the same token, so a retried delivery
   * sends the same link and the transport can deduplicate it. When
   * absent (dev without a key) every attempt mints a random token.
   */
  readonly deriveToken?: (request: ResetRequest) => Promise<string>;
  /** Base URL of the web app. Token is appended to build `link`. */
  readonly resetLinkBaseUrl: string;
  /** Optional clock injection for tests. */
  readonly now?: () => number;
  /** Optional TTL override (default 1 hour). */
  readonly tokenTtlSec?: number;
}

export type DeliverResetResult =
  | { readonly kind: 'sent' }
  /** The account was deleted (or anonymised) after the request: nothing to send. */
  | { readonly kind: 'skipped_inactive' }
  /** The request's token was used, or a later request replaced it. */
  | { readonly kind: 'skipped_superseded' };

/**
 * Deliver the reset email for a recorded request (issues #645, #650).
 *
 * The token is produced here, at delivery, rather than stored with the
 * request: the outbox, the queue message and the DLQ never hold a bearer
 * credential. It is derived from the request id, so every attempt for
 * the same request stores the same hash and emails the same link. An
 * attempt whose outcome was ambiguous (the provider may have accepted the
 * email before the connection dropped) is therefore safe to retry: it
 * cannot invalidate a link that was already delivered, and the transport
 * deduplicates the resend with `idempotencyKey`.
 *
 * Throws when the token cannot be stored or the email cannot be sent, so
 * the queue retries the message and dead-letters it once the retry
 * budget is spent.
 */
export async function deliverResetEmail(
  request: ResetRequest,
  deps: DeliverResetDeps,
): Promise<DeliverResetResult> {
  const user = await deps.userRepo.findUserById(request.userId);
  if (user === null || user.deletedAt !== null || !user.email) {
    return { kind: 'skipped_inactive' };
  }

  const ttlSec = deps.tokenTtlSec ?? DEFAULT_RESET_TOKEN_TTL_SEC;
  const nowMs = deps.now !== undefined ? deps.now() * 1000 : Date.now();
  const expiresAt = new Date(nowMs + ttlSec * 1000);
  const plainToken =
    deps.deriveToken !== undefined ? await deps.deriveToken(request) : generateRandomToken();
  const tokenHash = await sha256Hex(plainToken);

  const issued = await deps.tokens.issueForRequest({ userId: user.id, tokenHash, expiresAt });
  if (issued === 'inactive') return { kind: 'skipped_inactive' };
  if (issued === 'superseded') return { kind: 'skipped_superseded' };

  const link = `${stripTrailingSlashes(deps.resetLinkBaseUrl)}/reset-password/${plainToken}`;
  await deps.emailTransport.sendResetEmail({
    to: user.email,
    link,
    expiresAt,
    idempotencyKey: `password-reset/${request.requestId}`,
  });
  return { kind: 'sent' };
}

/** Minimum length of the secret given to {@link createResetTokenDeriver}. */
export const RESET_TOKEN_KEY_MIN_LENGTH = 32;

/**
 * Build a per-request token deriver: base64url(HMAC-SHA256(secret,
 * `athlya.password-reset.v1:<requestId>:<userId>`)), 256 bits. The
 * request id is not secret; without the key the token cannot be
 * computed from it.
 */
export function createResetTokenDeriver(
  secret: string,
): (request: ResetRequest) => Promise<string> {
  if (secret.length < RESET_TOKEN_KEY_MIN_LENGTH) {
    throw new Error(
      `password reset token key must be at least ${String(RESET_TOKEN_KEY_MIN_LENGTH)} characters`,
    );
  }
  const key = globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return async (request) => {
    const mac = await globalThis.crypto.subtle.sign(
      'HMAC',
      await key,
      new TextEncoder().encode(`athlya.password-reset.v1:${request.requestId}:${request.userId}`),
    );
    return toBase64Url(new Uint8Array(mac));
  };
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

  try {
    await deps.passwordResetRepo.consumeAndResetPassword({
      tokenHash,
      userId: found.userId,
      newPasswordHash,
    });
  } catch (err) {
    // The token can expire or be used by a concurrent reset during the
    // HIBP check and hashing above: a client error, not a 500.
    if (err instanceof PasswordResetTokenUnavailableError) {
      const nowAfterMs = deps.now !== undefined ? deps.now() * 1000 : Date.now();
      throw new AuthError(
        found.expiresAt.getTime() <= nowAfterMs ? 'token_expired' : 'token_invalid',
      );
    }
    throw err;
  }

  // Security-event posture: tear down every active session on
  // password reset. The user re-authenticates everywhere.
  await deps.sessionStore.revokeAllForUser(found.userId);

  return { userId: found.userId };
}

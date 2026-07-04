/**
 * Auth service use cases for `@athlya/auth`.
 *
 * This module is the orchestration layer that turns the stand-alone
 * primitives exported by the rest of the package (`password.ts`,
 * `hibp.ts`, `jwt.ts`, `throttle.ts`) into the seven operations the
 * API Gateway surfaces under `/v1/auth/*`:
 *
 *   - {@link register}            — password + HIBP + user row + session.
 *   - {@link login}                — bcrypt verify + session issuance.
 *   - {@link loginWithApple}      — provider ID-token verification +
 *                                   OAuth account linking.
 *   - {@link loginWithGoogle}     — same, for Google.
 *   - {@link refresh}             — rotate + reissue tokens.
 *   - {@link logout}              — revoke the session.
 *   - {@link deleteMe}            — soft-delete + fan-out RGPD cascade.
 *
 * ### Why dependency injection
 *
 * Every persistence, eventing and cryptographic concern is expressed
 * as an interface passed in {@link AuthServiceDeps}:
 *
 *   - {@link UserRepo}       owns rows in `users` and `studios`.
 *   - {@link SessionStore}   owns the refresh-token rotation ledger.
 *   - {@link OAuthVerifier}  validates provider ID tokens.
 *   - `publishEvent`         emits {@link AthlyaEvent}s on the bus.
 *
 * This keeps the domain logic free of Drizzle / Redis / Cloudflare
 * Queues imports and makes the test suite a tight set of `vi.fn()`
 * mocks — no DB fixtures, no network. The production wiring (a
 * Drizzle-backed `UserRepo`, an Upstash-backed `SessionStore`, a
 * `jose.createRemoteJWKSet`-backed `OAuthVerifier`) lives in later
 * tasks (5.1 for the repo, 8.x for the gateway wiring).
 *
 * Related requirements: 1.1, 1.2, 1.4, 1.5, 2.2, 5.1.
 */

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

import { HibpUnavailableError, isBreached as defaultIsBreached } from './hibp.js';
import {
  DEFAULT_ACCESS_TTL_SEC,
  DEFAULT_REFRESH_TTL_SEC,
  signAccess,
  signRefresh,
  verify as verifyJwt,
} from './jwt.js';
import { hash as hashPassword, verify as verifyPasswordHash } from './password.js';

import { classifyUserAgent, detectLoginAnomaly, type LoginSignal } from './login-anomaly.js';

import type { Jwks, RefreshClaims, SigningKey } from './jwt.js';
import type { LoginThrottleDecision } from './throttle.js';
import type { AthlyaEvent } from '@athlya/shared/events';
import type { UserId } from '@athlya/shared/ids';
import type { Consents } from '@athlya/shared/schemas';
import type { LoginRequest, RegisterRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Current CGU / privacy policy version bound to every newly-stamped
 * consents record. Requirement 3.3 mandates that the service (not the
 * client) is the authority on this value so a legacy client cannot
 * re-submit an outdated version.
 *
 * Shaped as `YYYY-MM` to match the Zod regex in
 * `@athlya/shared/schemas/consents`.
 */
export const CURRENT_CGU_VERSION = '2026-01';

/** Apple's well-known JWKS endpoint. Overridable via deps in tests. */
export const DEFAULT_APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/** Apple's expected `iss` claim on ID tokens. */
export const APPLE_ISSUER = 'https://appleid.apple.com';

/** Google's well-known JWKS endpoint. */
export const DEFAULT_GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Google's accepted `iss` claims. Both variants are legal per Google's
 * documentation and appear in the wild depending on the client library
 * that minted the token.
 */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/* ------------------------------------------------------------------ */
/*  Error types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Stable error codes surfaced by the Auth service. Each one maps 1:1
 * to an HTTP status + `application/problem+json` `code` by the API
 * Gateway:
 *
 *   - `password_breached`         → HTTP 422 (Req 1.2).
 *   - `studio_not_found`          → HTTP 422 (slug did not resolve).
 *   - `email_taken`               → HTTP 422 (unique-email collision).
 *   - `invalid_credentials`       → HTTP 401 (Req 1.5).
 *   - `token_invalid`             → HTTP 401 (Req 2.4).
 *   - `token_expired`             → HTTP 401 (Req 2.4).
 *   - `token_revoked`             → HTTP 401 (Sprint-2 SP2.1, family-tree
 *                                   revoke on refresh-reuse detection).
 *                                   Surfaced as the same opaque 401 as
 *                                   `token_invalid` to clients; the
 *                                   distinction lives in the audit log
 *                                   so an attacker cannot probe for it.
 *   - `oauth_verification_failed` → HTTP 401 (Req 1.4).
 *   - `rate_limited`              → HTTP 429 (Req 1.6).
 *   - `not_found`                 → HTTP 404 (user no longer exists).
 */
export type AuthErrorCode =
  | 'password_breached'
  | 'hibp_unavailable'
  | 'studio_not_found'
  | 'email_taken'
  | 'invalid_credentials'
  | 'token_invalid'
  | 'token_expired'
  | 'token_revoked'
  | 'oauth_verification_failed'
  | 'rate_limited'
  | 'not_found';

/**
 * Single exception type raised by every public function below. The
 * string `code` is the authoritative machine-readable identifier;
 * `message` exists only for logs and should never be surfaced verbatim
 * to end users (the gateway builds the user-facing message from the
 * localised Problem Details template keyed by `code`).
 */
export class AuthError extends Error {
  public override readonly name = 'AuthError';
  public readonly code: AuthErrorCode;
  /** Optional extra context — e.g. `retryAfterSec` for `rate_limited`. */
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(code: AuthErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.code = code;
    this.details = details;
  }
}

/**
 * Thrown by {@link UserRepo.createUser} when the underlying unique
 * constraint on `users.email` fires. The service layer catches it and
 * remaps it to {@link AuthError} with code `'email_taken'` so callers
 * never have to import a persistence-layer type.
 */
export class EmailTakenError extends Error {
  public override readonly name = 'EmailTakenError';
  public constructor() {
    super('email already registered');
  }
}

/* ------------------------------------------------------------------ */
/*  Domain row types                                                   */
/* ------------------------------------------------------------------ */

/**
 * Minimum shape the service needs from the `users` table. The
 * production Drizzle row has more columns (`created_at`, `avatar_url`,
 * …); we project to the set actually used by this module so the repo
 * implementation can hand back a narrower object on read.
 *
 * `passwordHash` is `null` when the user registered exclusively via
 * Apple / Google — the service treats that case as "no password set"
 * and rejects the `login` path for them.
 */
export interface UserRow {
  readonly id: string;
  readonly studioId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'member' | 'coach' | 'admin';
  readonly passwordHash: string | null;
  readonly deletedAt: Date | null;
}

/** Minimum shape the service needs from the `studios` table. */
export interface StudioRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Payload accepted by {@link UserRepo.createUser}. The repo takes
 * care of the SQL-level concerns (UUID default, `created_at`,
 * `deleted_at = NULL`); everything else is the service's
 * responsibility to compute.
 */
export interface CreateUserInput {
  readonly studioId: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly displayName: string;
  readonly role: 'member' | 'coach' | 'admin';
  readonly consents: Consents;
}

/* ------------------------------------------------------------------ */
/*  Repository and session-store contracts                             */
/* ------------------------------------------------------------------ */

/**
 * Thin abstraction over the persistence layer used by the Auth
 * service. Every method is async so production can front it with
 * Drizzle + Neon HTTP without breaking the interface.
 *
 * Contracts:
 *
 *   - {@link findUserByEmail}/{@link findUserById} — return `null`
 *     (NOT throw) when the row does not exist. Soft-deleted users
 *     are returned as well so the service can decide the right
 *     response (404 vs 401).
 *
 *   - {@link findStudioBySlug} — same null semantics.
 *
 *   - {@link createUser} — inserts a new row and returns the fully
 *     populated {@link UserRow}. Throws {@link EmailTakenError} on
 *     the unique-email violation so the service can reply 422 with
 *     the right code without peeking at SQLSTATE.
 *
 *   - {@link softDeleteUser} — sets `deleted_at = now()`. Idempotent:
 *     calling it on an already-deleted user is a no-op.
 *
 *   - {@link findOrCreateOAuthUser} — atomically links (or creates)
 *     a user by `(provider, sub)`. Returns the resulting row. When
 *     the user did not previously exist, `studioSlug` (optional) is
 *     consulted to bind the new row to a studio; when absent, the
 *     repo is allowed to fail with an `AuthError('studio_not_found')`
 *     (Apple / Google sign-in without a studio context is a bug the
 *     gateway must catch upstream).
 */
export interface UserRepo {
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;
  findStudioBySlug(slug: string): Promise<StudioRow | null>;
  createUser(input: CreateUserInput): Promise<UserRow>;
  softDeleteUser(id: string): Promise<void>;
  findOrCreateOAuthUser(
    provider: 'apple' | 'google',
    sub: string,
    email: string,
    studioSlug?: string,
  ): Promise<UserRow>;
}

/**
 * Outcome of a {@link SessionStore.rotate} call.
 *
 * `kind`:
 *   - `'ok'`            — atomic GETDEL+SETNX swap succeeded; old sid
 *                         consumed, new sid registered.
 *   - `'reuse_detected'` — the old sid was missing from the
 *                         per-sid ledger BUT the family map still
 *                         remembers it as a previously-rotated node
 *                         in a known chain. Strong signal of token
 *                         theft (Sprint-2 SP2.1 / Finding S2-004).
 *                         Caller MUST revoke the whole family and
 *                         emit an audit + suspicious event.
 *   - `'unknown'`       — the old sid is absent everywhere (already
 *                         expired, never existed, or forged). Caller
 *                         rejects with `token_invalid`; nothing else
 *                         to do.
 *
 * `rootSid` and `userId` are populated for both `'ok'` and
 * `'reuse_detected'` so the caller can drive
 * {@link SessionStore.revokeFamilyByRootSid} + audit log entries
 * without re-reading Redis.
 */
export type RotateResult =
  | {
      readonly kind: 'ok';
      readonly userId: string;
      readonly rootSid: string;
    }
  | {
      readonly kind: 'reuse_detected';
      readonly userId: string;
      readonly rootSid: string;
    }
  | { readonly kind: 'unknown' };

/**
 * Session ledger used to rotate and revoke refresh tokens.
 *
 * The in-memory production implementation stores one row per live
 * refresh token keyed by `sid` (session id). The refresh JWT itself
 * is stateless; the store is consulted to decide whether a given
 * `sid` is still valid — enabling both **rotation** (Req 2.2) and
 * **single-session invalidation** (Req 5.1 cascades through
 * {@link revokeAllForUser}).
 *
 * Contracts:
 *
 *   - {@link create}  — register a newly minted `sid` for `userId`.
 *                       Sprint-2 SP2.1: also seeds the family-tree
 *                       index with `rootSid = sid, parentSid = null`
 *                       so reuse-detection works on the first
 *                       rotation.
 *   - {@link rotate}  — atomically swap `oldSid` for `newSid`.
 *                       Returns a {@link RotateResult} discriminator
 *                       so the caller can distinguish between:
 *                         • happy path (`'ok'`),
 *                         • refresh-reuse on a known family
 *                           (`'reuse_detected'`) — caller MUST
 *                           revoke the whole family and audit-log
 *                           the event,
 *                         • truly unknown sid (`'unknown'`) — caller
 *                           rejects with `token_invalid`.
 *                       Implementations MUST guarantee atomicity
 *                       (single Lua script or equivalent
 *                       transaction) so two parallel rotations of
 *                       the same `oldSid` cannot both succeed.
 *   - {@link revoke}  — drop a specific `sid`; MUST NOT throw if the
 *                       sid was already absent (idempotent logout).
 *   - {@link revokeAllForUser} — drop every `sid` tied to `userId`.
 *                                Used by {@link deleteMe}.
 *   - {@link revokeFamilyByRootSid} — drop every sid in the rotation
 *                                     family rooted at `rootSid`,
 *                                     plus the family map and every
 *                                     sid_to_root pointer that
 *                                     references it. Idempotent.
 *                                     Used by {@link refresh} when
 *                                     `rotate` returns
 *                                     `'reuse_detected'`.
 *   - {@link exists}  — reserved for verify-only code paths.
 */
export interface SessionStore {
  create(userId: string, sid: string, expiresAt: Date): Promise<void>;
  rotate(oldSid: string, newSid: string, newExpiresAt: Date): Promise<RotateResult>;
  revoke(sid: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
  revokeFamilyByRootSid(rootSid: string): Promise<void>;
  exists(sid: string): Promise<boolean>;
}

/**
 * Pluggable verifier for provider ID tokens. The production
 * implementation uses `jose.createRemoteJWKSet` against the relevant
 * provider endpoint; tests inject a simple `vi.fn()` so the suite
 * never needs network access or cached JWKS material.
 *
 * A successful verification returns just the pair the service needs
 * to link the local account; any failure MUST throw so the service
 * layer can map it to `oauth_verification_failed`.
 */
export interface OAuthVerifier {
  verify(idToken: string, provider: 'apple' | 'google'): Promise<{ sub: string; email: string }>;
}

/* ------------------------------------------------------------------ */
/*  Session value object                                               */
/* ------------------------------------------------------------------ */

/**
 * What every public use case returns on the happy path. Mirrors the
 * `SessionResponseSchema` exposed at the API boundary but with the
 * domain-level {@link UserRow} embedded instead of the API schema
 * shape — the gateway re-serialises through
 * `SessionResponseSchema.parse` before emitting.
 *
 * `accessExp` / `refreshExp` are Unix seconds so the gateway can
 * compute `expiresIn = exp - now()` on its own clock, avoiding any
 * client-side drift between issuance and response dispatch.
 */
export interface Session {
  readonly user: UserRow;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExp: number;
  readonly refreshExp: number;
  /** The `sid` tied to {@link refreshToken}, surfaced for logging. */
  readonly sid: string;
}

/* ------------------------------------------------------------------ */
/*  Service dependencies                                               */
/* ------------------------------------------------------------------ */

/**
 * Tunables surfaced by the service. All fields are optional; sensible
 * defaults (Apple/Google endpoints, JWT TTLs) are pinned to the same
 * constants used in production.
 */
export interface AuthServiceOptions {
  readonly accessTtlSec?: number;
  readonly refreshTtlSec?: number;
  readonly appleJwksUrl?: string;
  readonly appleAudience?: string;
  readonly googleJwksUrl?: string;
  readonly googleAudience?: string;
  /** Issuer to stamp on every minted access / refresh JWT. */
  readonly jwtIssuer?: string;
  /** Audience to stamp on every minted access / refresh JWT. */
  readonly jwtAudience?: string;
}

/**
 * Full dependency bundle for the Auth service. Instantiated once per
 * Worker and passed into every use case; no global / module-scoped
 * mutable state lives in this file.
 */
export interface AuthServiceDeps {
  readonly userRepo: UserRepo;
  readonly sessionStore: SessionStore;
  readonly signingKey: SigningKey;
  readonly jwks: Jwks;
  readonly publishEvent: (event: AthlyaEvent) => Promise<void>;
  /**
   * Optional injected clock (seconds since epoch). Defaults to
   * `Math.floor(Date.now() / 1000)`. Tests pin it to keep JWT
   * `iat`/`exp` deterministic.
   */
  readonly now?: () => number;
  /**
   * Optional injected UUID source. Defaults to
   * `crypto.randomUUID()`. Tests pin it to assert specific `sid`
   * values flow through the session store.
   */
  readonly uuid?: () => string;
  /**
   * Optional injected `fetch` for the HIBP k-anonymity lookup.
   * Defaults to `globalThis.fetch`.
   */
  readonly hibpFetch?: typeof fetch;
  /**
   * When `true`, a HIBP outage causes registration and password-reset
   * to reject with `AuthError('hibp_unavailable')` (HTTP 422) rather
   * than silently proceeding. Set to `true` in production to prevent
   * a HIBP outage from allowing breached passwords through.
   * Defaults to `false` (fail-open).
   */
  readonly hibpFailClosed?: boolean;
  /**
   * Optional injected OAuth verifier. Defaults to one built from
   * `jose.createRemoteJWKSet` using the provider endpoints in
   * {@link AuthServiceOptions}. Tests override this to short-circuit
   * the network round-trip.
   */
  readonly oauthVerifier?: OAuthVerifier;
  /**
   * Optional audit log writer. When provided, the {@link refresh}
   * use case calls it with a `token.refresh.reuse.detected` entry
   * whenever the session store reports a refresh-reuse on a known
   * family (Sprint-2 SP2.1 / Finding S2-004). The dep is optional
   * so unit tests that do not exercise the reuse path can leave it
   * undefined; production deps wire a Drizzle-backed writer.
   *
   * The entry shape is intentionally narrow:
   *   - `actorId`   — the `userId` whose family was revoked.
   *   - `action`    — always `'token.refresh.reuse.detected'`.
   *   - `metadata`  — `{ rootSid, oldSid }` only. PII-safe — no
   *                   IP, UA or email; the audit row is keyed on
   *                   `actorId` for that.
   *
   * Failures are swallowed by the service: a missing audit row
   * must not mask the security signal (the family is already
   * revoked and the suspicious event is published).
   */
  readonly appendAudit?: (entry: ReuseAuditEntry) => Promise<void>;
  /**
   * Optional login anomaly detector dep (Sprint 12 / Slice 12.15,
   * Epic B3.4). When provided, the {@link login} use case reads
   * the user's last known signal from the store, runs
   * {@link detectLoginAnomaly}, persists the new signal, and (on
   * detected anomaly) emits `auth.suspicious.login.anomaly`.
   *
   * Failures are swallowed by the service: a missing or unreachable
   * anomaly store must not mask the user-visible login success.
   */
  readonly loginAnomalyStore?: {
    getSignal(userId: string): Promise<LoginSignal | null>;
    setSignal(userId: string, signal: LoginSignal): Promise<void>;
  };
  readonly options?: AuthServiceOptions;
}

/**
 * Shape of the audit entry written by the {@link refresh} use case
 * on refresh-reuse detection. Mirrors `AuditEntry` from
 * `@athlya/api/audit` without taking a hard dependency on the API
 * package — the production wiring narrows the param at the adapter
 * boundary.
 */
export interface ReuseAuditEntry {
  readonly actorId: string;
  readonly action: 'token.refresh.reuse.detected';
  readonly metadata: {
    readonly rootSid: string;
    readonly oldSid: string;
  };
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

function nowSec(deps: AuthServiceDeps): number {
  return (deps.now ?? defaultNow)();
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

function newUuid(deps: AuthServiceDeps): string {
  return (deps.uuid ?? (() => crypto.randomUUID()))();
}

function accessTtl(deps: AuthServiceDeps): number {
  return deps.options?.accessTtlSec ?? DEFAULT_ACCESS_TTL_SEC;
}

function refreshTtl(deps: AuthServiceDeps): number {
  return deps.options?.refreshTtlSec ?? DEFAULT_REFRESH_TTL_SEC;
}

/**
 * Lowered once in {@link register} and reused for the event payload.
 * The API schema (`RegisterRequestSchema`) already lower-cases the
 * email via Zod's `.transform`, but defensive lower-casing is cheap
 * and makes this function safe to call with an un-transformed body
 * from tests or internal callers.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Common tail of every "issue a session" flow. Mints a fresh `sid`,
 * signs access + refresh tokens, records the sid in the session
 * store, and returns the complete {@link Session}.
 *
 * Extracted so `register`, `login`, `loginWithApple`, `loginWithGoogle`
 * and `refresh` all agree on the exact sequence of writes and the
 * exact claims shape.
 */
async function mintSession(user: UserRow, deps: AuthServiceDeps): Promise<Session> {
  const sid = newUuid(deps);
  const iat = nowSec(deps);
  const accessExp = iat + accessTtl(deps);
  const refreshExp = iat + refreshTtl(deps);

  // Persist the sid BEFORE signing so a crash between signing and
  // storing never produces a "ghost" refresh token the service will
  // later reject on rotation. The store is the authoritative ledger;
  // the JWT is the opaque proof of possession.
  await deps.sessionStore.create(user.id, sid, new Date(refreshExp * 1000));

  const signingKey = deps.signingKey;
  const issuer = deps.options?.jwtIssuer;
  const audience = deps.options?.jwtAudience;

  const [accessToken, refreshToken] = await Promise.all([
    signAccess(
      { sub: user.id, studio: user.studioId, role: user.role },
      {
        signingKey,
        ttlSec: accessTtl(deps),
        now: () => iat,
        ...(issuer !== undefined ? { issuer } : {}),
        ...(audience !== undefined ? { audience } : {}),
      },
    ),
    signRefresh(
      { sub: user.id, sid },
      {
        signingKey,
        ttlSec: refreshTtl(deps),
        now: () => iat,
        ...(issuer !== undefined ? { issuer } : {}),
        ...(audience !== undefined ? { audience } : {}),
      },
    ),
  ]);

  return { user, accessToken, refreshToken, accessExp, refreshExp, sid };
}

/**
 * Build the `auth.user.registered` envelope. Centralised so the `id`,
 * `occurredAt` and optional `studioId` fields are stamped consistently.
 */
function buildUserRegisteredEvent(
  deps: AuthServiceDeps,
  payload: { userId: UserId },
  studioId: string,
): AthlyaEvent {
  const occurredAt = new Date(nowSec(deps) * 1000).toISOString();
  return {
    id: newUuid(deps),
    type: 'auth.user.registered',
    occurredAt,
    studioId,
    payload,
  } as unknown as AthlyaEvent;
}

/**
 * Build the `auth.user.deleted` envelope. Same rationale as
 * {@link buildUserRegisteredEvent}.
 */
function buildUserDeletedEvent(
  deps: AuthServiceDeps,
  payload: { userId: UserId },
  studioId: string,
): AthlyaEvent {
  const occurredAt = new Date(nowSec(deps) * 1000).toISOString();
  return {
    id: newUuid(deps),
    type: 'auth.user.deleted',
    occurredAt,
    studioId,
    payload,
  } as unknown as AthlyaEvent;
}

/* ------------------------------------------------------------------ */
/*  register                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create a brand-new local user + initial session.
 *
 * Sequence (Req 1.1, 1.2, 1.4, 16.1):
 *
 *   1. Resolve the studio by slug (reject `studio_not_found`).
 *   2. Check the password against HIBP. A hit rejects with
 *      `password_breached` (Req 1.2). A {@link HibpUnavailableError}
 *      is treated **fail-open** (issue #233): registration proceeds
 *      and a `console.warn` metric is emitted so ops can detect HIBP
 *      outages via Axiom.
 *   3. Hash the password with bcrypt cost 12.
 *   4. Insert the user row; map unique-email violations to
 *      `email_taken`.
 *   5. Mint a session (see {@link mintSession}).
 *   6. Emit `auth.user.registered` on the bus.
 *
 * The caller is responsible for Zod-validating `input` upstream; this
 * function trusts the shape but defensively normalises the email
 * before passing it to the repo.
 *
 * @throws {@link AuthError} with one of:
 *   `studio_not_found`, `password_breached`, `email_taken`.
 */
export async function register(input: RegisterRequest, deps: AuthServiceDeps): Promise<Session> {
  const email = normaliseEmail(input.email);

  const studio = await deps.userRepo.findStudioBySlug(input.studioSlug);
  if (studio === null) {
    throw new AuthError('studio_not_found');
  }

  // Fail-open by default (issue #233) so a HIBP outage never blocks
  // all registrations. Pass `hibpFailClosed: true` in production to
  // reject with `hibp_unavailable` instead of silently proceeding.
  let breached: boolean;
  try {
    breached = await defaultIsBreached(
      input.password,
      deps.hibpFetch !== undefined ? { fetch: deps.hibpFetch } : {},
    );
  } catch (err) {
    if (err instanceof HibpUnavailableError) {
      console.warn('athlya.hibp.degraded', {
        metric: 'hibp_degraded',
        degraded: true,
        op: 'register',
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

  const passwordHash = await hashPassword(input.password);

  const consents: Consents = {
    ...input.consents,
    version: CURRENT_CGU_VERSION,
    updatedAt: new Date(nowSec(deps) * 1000).toISOString(),
  };

  let user: UserRow;
  try {
    user = await deps.userRepo.createUser({
      studioId: studio.id,
      email,
      passwordHash,
      displayName: input.displayName,
      role: 'member',
      consents,
    });
  } catch (err) {
    if (err instanceof EmailTakenError) {
      throw new AuthError('email_taken');
    }
    throw err;
  }

  const session = await mintSession(user, deps);

  // The `auth.user.registered` payload's `userId` is a branded UserId
  // in the shared schema. The repo-provided id is a plain string;
  // we brand it here without an extra UUID parse (the DB returned a
  // fresh UUID v7). Sprint-2 SP2.2 (S5-005) — the `email` field
  // was removed; consumers fetch it from the user repo on demand.
  await deps.publishEvent(
    buildUserRegisteredEvent(
      deps,
      {
        userId: user.id as UserId,
      },
      user.studioId,
    ),
  );

  return session;
}

/* ------------------------------------------------------------------ */
/*  login                                                              */
/* ------------------------------------------------------------------ */

/**
 * Optional pre-check surfaced by {@link login}. The gateway runs the
 * login-attempt throttle (`shouldAllowLogin` from `./throttle.js`)
 * before calling the service and passes its decision in so the
 * service can reject with `rate_limited` consistently across
 * credential-based and OAuth flows (Req 1.6).
 *
 * Kept as an option rather than a required argument so callers that
 * apply throttling at a different layer (scripts, internal tests) are
 * not forced to stub it.
 */
export interface LoginOptions {
  readonly throttle?: LoginThrottleDecision;
  /**
   * Sprint 12 / Slice 12.15 (Epic B3.4) — request-scoped login
   * signal used by the anomaly detector. Populated by the
   * gateway's auth handler from `CF-IPCountry` + `User-Agent`
   * headers. Optional: when absent, anomaly detection is
   * skipped and the login still succeeds.
   */
  readonly anomalySignal?: {
    readonly country: string | undefined;
    readonly userAgent: string | undefined;
  };
}

/**
 * Verify `(email, password)` against the local user row and issue a
 * fresh session.
 *
 * Security invariants:
 *
 *   - Failure paths (user missing, soft-deleted, OAuth-only,
 *     password mismatch) ALL surface as the single opaque code
 *     `invalid_credentials`. Distinguishing them at the wire would
 *     let an attacker enumerate registered emails; the audit log
 *     (written by the gateway) keeps the internal distinction for
 *     incident response.
 *
 *   - bcrypt verification runs even when the stored hash is `null`
 *     (OAuth-only user) or the user was not found — skipping it
 *     opens a trivial timing oracle. We achieve this by calling
 *     {@link verifyPasswordHash} against a dummy salt / hash in
 *     those branches before returning the opaque error.
 *
 * @throws {@link AuthError} with `rate_limited` (gateway throttle hit)
 *   or `invalid_credentials`.
 */
export async function login(
  input: LoginRequest,
  deps: AuthServiceDeps,
  options: LoginOptions = {},
): Promise<Session> {
  if (options.throttle !== undefined && options.throttle.allow === false) {
    const details: Record<string, unknown> = {};
    if (options.throttle.retryAfterSec !== undefined) {
      details['retryAfterSec'] = options.throttle.retryAfterSec;
    }
    throw new AuthError('rate_limited', 'too many login attempts', details);
  }

  const email = normaliseEmail(input.email);
  const user = await deps.userRepo.findUserByEmail(email);

  // Always perform a bcrypt-like comparison to keep timing uniform
  // across every failure branch. `verifyPasswordHash('x', '...')`
  // runs one round of bcrypt against a well-formed but wrong hash —
  // the result is always `false`, which is what we want here.
  const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKxGhuRuuLnJKqFkDpKpOL6qJ5Hd.GTLQ5Ere';

  if (user === null || user.deletedAt !== null || user.passwordHash === null) {
    // Burn time proportional to a real verify to avoid a timing
    // oracle distinguishing missing user / deleted / OAuth-only
    // from "wrong password".
    await verifyPasswordHash(input.password, DUMMY_HASH).catch(() => false);
    throw new AuthError('invalid_credentials');
  }

  const ok = await verifyPasswordHash(input.password, user.passwordHash);
  if (!ok) {
    throw new AuthError('invalid_credentials');
  }

  const session = await mintSession(user, deps);

  // Sprint 12 / Slice 12.15 (Epic B3.4) — anomaly detection. Best
  // effort: a missing store, a Redis hiccup, or a malformed
  // request signal must NOT block the login. Detection happens
  // strictly after `mintSession` returns; the user's session is
  // already valid by the time we read/write the lastlogin
  // signal.
  if (deps.loginAnomalyStore !== undefined && options.anomalySignal !== undefined) {
    try {
      const previous = await deps.loginAnomalyStore.getSignal(user.id);
      const anomaly = detectLoginAnomaly({
        currentCountry: options.anomalySignal.country,
        currentUserAgent: options.anomalySignal.userAgent,
        previous,
      });

      // Persist the new signal regardless — establishes the
      // baseline on first login, refreshes the timestamp on
      // subsequent ones. We compute the country + UA family
      // identical to `detectLoginAnomaly` so the next
      // comparison sees the same canonicalised values.
      const newSignal: LoginSignal = {
        country:
          typeof options.anomalySignal.country === 'string' &&
          /^[A-Z]{2}$/u.test(options.anomalySignal.country.toUpperCase())
            ? options.anomalySignal.country.toUpperCase()
            : 'XX',
        uaFamily: anomaly?.uaFamily ?? classifyUserAgent(options.anomalySignal.userAgent),
      };
      await deps.loginAnomalyStore.setSignal(user.id, newSignal);

      if (anomaly !== null) {
        const event: AthlyaEvent = {
          id: newUuid(deps),
          type: 'auth.suspicious.login.anomaly',
          occurredAt: new Date(
            (deps.now?.() ?? Math.floor(Date.now() / 1000)) * 1000,
          ).toISOString(),
          studioId: user.studioId,
          payload: {
            userId: user.id as UserId,
            country: anomaly.country,
            previousCountry: anomaly.previousCountry,
            uaFamily: anomaly.uaFamily,
            previousUaFamily: anomaly.previousUaFamily,
          },
        } as unknown as AthlyaEvent;
        await deps.publishEvent(event);
      }
    } catch (err) {
      console.warn('[auth] anomaly detection failed — best-effort skipped', {
        code: 'anomaly_detection_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return session;
}

/* ------------------------------------------------------------------ */
/*  OAuth sign-in                                                      */
/* ------------------------------------------------------------------ */

/**
 * Lazily build the default OAuth verifier from `jose.createRemoteJWKSet`.
 * Computed once per `deps` instance via the closure below; tests
 * override `deps.oauthVerifier` to avoid any network I/O.
 */
function resolveOAuthVerifier(deps: AuthServiceDeps): OAuthVerifier {
  if (deps.oauthVerifier !== undefined) {
    return deps.oauthVerifier;
  }
  const appleUrl = deps.options?.appleJwksUrl ?? DEFAULT_APPLE_JWKS_URL;
  const googleUrl = deps.options?.googleJwksUrl ?? DEFAULT_GOOGLE_JWKS_URL;
  const appleJwks = createRemoteJWKSet(new URL(appleUrl));
  const googleJwks = createRemoteJWKSet(new URL(googleUrl));

  return {
    async verify(idToken, provider) {
      const { payload } = await jwtVerify(idToken, provider === 'apple' ? appleJwks : googleJwks, {
        algorithms: ['RS256', 'ES256'],
        issuer: provider === 'apple' ? APPLE_ISSUER : [...GOOGLE_ISSUERS],
        ...(provider === 'apple' && deps.options?.appleAudience !== undefined
          ? { audience: deps.options.appleAudience }
          : {}),
        ...(provider === 'google' && deps.options?.googleAudience !== undefined
          ? { audience: deps.options.googleAudience }
          : {}),
      });
      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const email = typeof payload['email'] === 'string' ? payload['email'] : '';
      if (sub.length === 0 || email.length === 0) {
        throw new Error('oauth: missing sub or email claim');
      }
      return { sub, email };
    },
  };
}

/**
 * Generic OAuth login body, specialised by {@link loginWithApple} and
 * {@link loginWithGoogle}. Requirement 1.4 mandates the ID token is
 * validated against the provider JWKS BEFORE any account creation /
 * linking — so the verifier call is always the first step.
 */
async function loginWithOAuth(
  provider: 'apple' | 'google',
  idToken: string,
  deps: AuthServiceDeps,
  studioSlug?: string,
): Promise<Session> {
  const verifier = resolveOAuthVerifier(deps);

  let result: { sub: string; email: string };
  try {
    result = await verifier.verify(idToken, provider);
  } catch (err) {
    throw new AuthError('oauth_verification_failed', undefined, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const user = await deps.userRepo.findOrCreateOAuthUser(
    provider,
    result.sub,
    normaliseEmail(result.email),
    studioSlug,
  );

  // Soft-deleted users must not be able to sign back in through the
  // OAuth path either — surface the opaque failure.
  if (user.deletedAt !== null) {
    throw new AuthError('invalid_credentials');
  }

  return mintSession(user, deps);
}

/**
 * Apple Sign-In. Validates `idToken` against Apple's JWKS and either
 * links the Apple `sub` to an existing local account or creates one.
 * Requirement 1.4.
 *
 * @throws {@link AuthError} with `oauth_verification_failed` when the
 *   JWKS verification, `iss`, `aud`, or time-window checks fail.
 */
export function loginWithApple(
  idToken: string,
  deps: AuthServiceDeps,
  studioSlug?: string,
): Promise<Session> {
  return loginWithOAuth('apple', idToken, deps, studioSlug);
}

/**
 * Google Sign-In. Validates `idToken` against Google's JWKS and either
 * links the Google `sub` to an existing local account or creates one.
 * Requirement 1.4.
 */
export function loginWithGoogle(
  idToken: string,
  deps: AuthServiceDeps,
  studioSlug?: string,
): Promise<Session> {
  return loginWithOAuth('google', idToken, deps, studioSlug);
}

/* ------------------------------------------------------------------ */
/*  refresh                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rotate a refresh token for a fresh pair of (access, refresh) tokens.
 *
 * Sequence (Req 2.2 + Sprint-2 SP2.1):
 *
 *   1. Verify the refresh JWT signature and time window against the
 *      local JWKS. Expired tokens surface as `token_expired`; all
 *      other verification failures surface as `token_invalid`.
 *   2. Extract `sub` (userId) and `sid` (session id). Missing or
 *      malformed claims → `token_invalid`.
 *   3. Load the user. If missing or soft-deleted → `invalid_credentials`.
 *   4. {@link SessionStore.rotate} atomically swaps the old sid for
 *      a fresh one. Three outcomes:
 *        - `'ok'`            → continue and sign new tokens.
 *        - `'unknown'`       → the sid was never (or no longer)
 *          recorded. Reject with `token_invalid` — the gateway
 *          surfaces this as the same opaque 401 a forged token
 *          would.
 *        - `'reuse_detected'` → the sid was already rotated AND its
 *          family is still live. This is a strong signal of token
 *          theft (Finding S2-004). The service:
 *            (a) calls {@link SessionStore.revokeFamilyByRootSid} to
 *                kick every descendant out (including the chain the
 *                legitimate user is still using — compromise is
 *                presumed, the user re-authenticates),
 *            (b) writes an audit `token.refresh.reuse.detected`
 *                entry via the optional `appendAudit` dep (PII-safe:
 *                only `rootSid` + `oldSid` are recorded — no IP, UA
 *                or email),
 *            (c) publishes `auth.suspicious.refresh.reuse` on the
 *                bus so downstream alerting can fan-out,
 *            (d) rejects with `token_revoked` (mapped to 401 by the
 *                gateway, distinct from `token_invalid` only at the
 *                machine-readable code level).
 *   5. Sign the new access + refresh tokens.
 *
 * The session store does not need a "create" call for the new sid —
 * {@link SessionStore.rotate} has already recorded it atomically.
 */
export async function refresh(refreshToken: string, deps: AuthServiceDeps): Promise<Session> {
  let claims: RefreshClaims;
  try {
    claims = await verifyJwt<RefreshClaims>(refreshToken, deps.jwks, {
      ...(deps.options?.jwtIssuer !== undefined ? { issuer: deps.options.jwtIssuer } : {}),
      ...(deps.options?.jwtAudience !== undefined ? { audience: deps.options.jwtAudience } : {}),
      ...(deps.now !== undefined ? { currentDate: new Date(deps.now() * 1000) } : {}),
    });
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AuthError('token_expired');
    }
    throw new AuthError('token_invalid', undefined, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const sid = typeof claims.sid === 'string' ? claims.sid : '';
  if (sub.length === 0 || sid.length === 0) {
    throw new AuthError('token_invalid');
  }

  const user = await deps.userRepo.findUserById(sub);
  if (user === null || user.deletedAt !== null) {
    throw new AuthError('invalid_credentials');
  }

  const newSid = newUuid(deps);
  const iat = nowSec(deps);
  const newExpiresAt = new Date((iat + refreshTtl(deps)) * 1000);
  const rotateOutcome = await deps.sessionStore.rotate(sid, newSid, newExpiresAt);
  if (rotateOutcome.kind === 'unknown') {
    // Old sid is gone everywhere — expired, never existed, or
    // forged. Same opaque 401 either way.
    throw new AuthError('token_invalid');
  }
  if (rotateOutcome.kind === 'reuse_detected') {
    // Sprint-2 SP2.1 — Finding S2-004. The presented sid was a
    // legitimate, already-rotated node in a known family. Two
    // copies of the same refresh token are now live in the wild;
    // we presume compromise and tear the whole family down.
    await deps.sessionStore.revokeFamilyByRootSid(rotateOutcome.rootSid);
    if (deps.appendAudit !== undefined) {
      try {
        // PII-safe: rootSid + oldSid only. No IP, no UA, no
        // email — anything that ties this audit row to a
        // person flows through the actorId column already.
        await deps.appendAudit({
          actorId: rotateOutcome.userId,
          action: 'token.refresh.reuse.detected',
          metadata: {
            rootSid: rotateOutcome.rootSid,
            oldSid: sid,
          },
        });
      } catch {
        // Audit must not mask the security signal — swallow
        // and continue to the suspicious-event publish below.
        // The Drizzle adapter logs the failure separately.
      }
    }
    try {
      const occurredAt = new Date(iat * 1000).toISOString();
      // The event arm is added in @athlya/shared as part of
      // SP2.1; we hand-build the envelope here so the cast
      // below is the only allow-list site.
      const suspicious: AthlyaEvent = {
        id: newUuid(deps),
        type: 'auth.suspicious.refresh.reuse',
        occurredAt,
        studioId: user.studioId,
        payload: {
          userId: user.id as UserId,
          rootSid: rotateOutcome.rootSid,
        },
      } as unknown as AthlyaEvent;
      await deps.publishEvent(suspicious);
    } catch {
      // Best-effort emission. Even without the event, the
      // family is already revoked and the audit is logged —
      // the next request from any descendant token will fail.
    }
    throw new AuthError('token_revoked');
  }

  // Re-use `mintSession` would double-record the sid (create +
  // rotate), so we hand-assemble the session with the sid the
  // session store has already committed.
  const signingKey = deps.signingKey;
  const issuer = deps.options?.jwtIssuer;
  const audience = deps.options?.jwtAudience;

  const accessExp = iat + accessTtl(deps);
  const refreshExp = iat + refreshTtl(deps);

  const [accessToken, newRefreshToken] = await Promise.all([
    signAccess(
      { sub: user.id, studio: user.studioId, role: user.role },
      {
        signingKey,
        ttlSec: accessTtl(deps),
        now: () => iat,
        ...(issuer !== undefined ? { issuer } : {}),
        ...(audience !== undefined ? { audience } : {}),
      },
    ),
    signRefresh(
      { sub: user.id, sid: newSid },
      {
        signingKey,
        ttlSec: refreshTtl(deps),
        now: () => iat,
        ...(issuer !== undefined ? { issuer } : {}),
        ...(audience !== undefined ? { audience } : {}),
      },
    ),
  ]);

  return {
    user,
    accessToken,
    refreshToken: newRefreshToken,
    accessExp,
    refreshExp,
    sid: newSid,
  };
}

/* ------------------------------------------------------------------ */
/*  logout                                                             */
/* ------------------------------------------------------------------ */

/**
 * Revoke the session behind `refreshToken`. Idempotent: logging out
 * an already-revoked (or unknown) sid is a no-op so clients can safely
 * retry on network flakes.
 *
 * We still verify the token signature before touching the store so a
 * forged token cannot be used to reconnaissance sid space. Expired
 * tokens however are treated as "already effectively revoked" — we
 * parse the sid and revoke anyway to keep the ledger tidy.
 */
export async function logout(refreshToken: string, deps: AuthServiceDeps): Promise<void> {
  let claims: RefreshClaims;
  try {
    claims = await verifyJwt<RefreshClaims>(refreshToken, deps.jwks, {
      ...(deps.options?.jwtIssuer !== undefined ? { issuer: deps.options.jwtIssuer } : {}),
      ...(deps.options?.jwtAudience !== undefined ? { audience: deps.options.jwtAudience } : {}),
      ...(deps.now !== undefined ? { currentDate: new Date(deps.now() * 1000) } : {}),
    });
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      // Tolerate expired tokens: the sid is still meaningful as
      // a lookup key for the ledger entry we want to drop.
      const unsafe = decodeUnsafeRefresh(refreshToken);
      if (unsafe !== null && unsafe.sid.length > 0) {
        await deps.sessionStore.revoke(unsafe.sid);
      }
      return;
    }
    throw new AuthError('token_invalid');
  }

  const sid = typeof claims.sid === 'string' ? claims.sid : '';
  if (sid.length === 0) {
    throw new AuthError('token_invalid');
  }
  // SessionStore.revoke is documented as idempotent; no try/catch
  // for "already revoked".
  await deps.sessionStore.revoke(sid);
}

/**
 * Sprint-4 Slice 4.1 (Vague 32, audit finding S2-010 [HIGH]) —
 * "kick out every device". Distinct from {@link logout} which only
 * drops the sid presented in the refresh cookie. Use cases:
 *
 *   • The user lost their phone and wants every active session
 *     terminated.
 *   • A security alert (suspicious-event banner) prompts a
 *     "sign out everywhere" CTA.
 *   • Future: triggered automatically by the
 *     `auth.suspicious.refresh.reuse` consumer (Vague 29) so a
 *     reuse signal cleans up the entire user surface, not just the
 *     family that triggered it.
 *
 * Idempotent — calling twice is a no-op the second time
 * ({@link SessionStore.revokeAllForUser} is documented as
 * idempotent).
 *
 * Authoriz contract: the gateway gates this endpoint behind
 * `jwtAuth()`; the verified `userId` from the access token is
 * passed in directly. We do NOT take a refresh token here because
 * the user might be calling this from a session that doesn't have
 * a fresh refresh cookie (e.g. mobile app where only the access
 * token is in memory).
 */
export async function logoutAll(userId: string, deps: AuthServiceDeps): Promise<void> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new AuthError('token_invalid');
  }
  await deps.sessionStore.revokeAllForUser(userId);
}

/**
 * Decode the payload of a compact JWS without verifying the signature.
 * ONLY used in the {@link logout} fallback path for expired tokens —
 * where we do not care about authenticity but still want to drop the
 * sid from the ledger as a courtesy to the user.
 *
 * Returns `null` if the token is not a well-formed three-segment JWS
 * or the payload does not parse as JSON.
 */
function decodeUnsafeRefresh(token: string): { sub: string; sid: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payloadSeg = parts[1] ?? '';
  try {
    const padded = payloadSeg
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(payloadSeg.length + ((4 - (payloadSeg.length % 4)) % 4), '=');
    const json = globalThis.atob(padded);
    const obj = JSON.parse(json) as { sub?: unknown; sid?: unknown };
    return {
      sub: typeof obj.sub === 'string' ? obj.sub : '',
      sid: typeof obj.sid === 'string' ? obj.sid : '',
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  deleteMe                                                           */
/* ------------------------------------------------------------------ */

/**
 * Mark the requesting user as soft-deleted and publish
 * `auth.user.deleted`. Requirement 5.1 + 16.1.
 *
 * Sequence:
 *
 *   1. Load the user. If missing → `not_found`.
 *   2. Soft-delete (`deleted_at = now()`).
 *   3. Revoke every live session tied to the user so in-flight tokens
 *      stop working immediately — without this the user's existing
 *      devices would continue to enjoy the access token until its
 *      15-minute TTL, which contradicts the spirit of the erasure
 *      request.
 *   4. Publish `auth.user.deleted` on the bus. Consumer (task 5.4)
 *      performs the full RGPD cascade (reservations, sessions,
 *      R2 avatars, …).
 *
 * Idempotent: calling `deleteMe` on an already-deleted user re-runs
 * steps 2–4 and returns normally. The second emission of
 * `auth.user.deleted` is deduped downstream on `event.id` (Req 17.4).
 */
export async function deleteMe(userId: string, deps: AuthServiceDeps): Promise<void> {
  const user = await deps.userRepo.findUserById(userId);
  if (user === null) {
    throw new AuthError('not_found');
  }

  await deps.userRepo.softDeleteUser(user.id);
  await deps.sessionStore.revokeAllForUser(user.id);

  await deps.publishEvent(
    buildUserDeletedEvent(deps, { userId: user.id as UserId }, user.studioId),
  );
}

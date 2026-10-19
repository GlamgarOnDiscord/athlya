/**
 * Compose the `AuthDeps` bundle from a live `AthlyaBindings` env.
 *
 * Wires the three adapter primitives shipped under
 * `packages/api/src/adapters/`:
 *
 *   - `createDrizzleUserRepo` — users / studios read-write backed by
 *     the Neon connection string in `env.DB_URL`.
 *   - `createRedisSessionStore` — refresh-token rotation ledger
 *     backed by Upstash Redis in `env.REDIS_URL` + `env.REDIS_TOKEN`.
 *   - `loadKeyPairFromPem` — materialises the `SigningKey` from the
 *     PEM blobs in `env.JWT_PRIVATE_KEY_PEM` + `env.JWT_PUBLIC_KEY_PEM`
 *     + `env.JWT_KID`.
 *
 * Plus the event publisher:
 *
 *   - Uses `env.EVENTS_QUEUE` (Cloudflare Queues producer binding) to
 *     publish `auth.user.registered` / `auth.user.deleted` events
 *     via the `publish` helper from `@athlya/api/events/publish`.
 *   - Durability (issue #411): `auth.user.registered` / `auth.user.deleted`
 *     are recorded in the outbox by the user repo in the same statement
 *     as the user mutation (migration 0033), then dispatched to the
 *     queue best-effort via `dispatchRecordedEvent`. Advisory events
 *     (`auth.suspicious.*`) go through `publishEvent`, which records them
 *     with `auth_record_event` — no BYPASSRLS needed under `athlya_app`.
 *
 * Cloudflare Workers caching strategy (Vague 18 — slice B1)
 * ---------------------------------------------------------
 * The Drizzle handle now uses `@neondatabase/serverless`'s HTTP
 * driver (`createDbHttp`). Each query is a stateless `fetch` to
 * Neon's SQL-over-HTTP endpoint, with NO long-lived TCP socket. The
 * "Cannot perform I/O on behalf of a different request" failure
 * mode that forced a per-request rebuild on the previous postgres-js
 * wiring therefore cannot occur, and the handle is safe to cache
 * across requests inside one isolate.
 *
 * The Upstash Redis client has always been HTTP-stateless (every
 * call goes through `fetch`); we cache it identically so a Worker
 * isolate keeps a stable instance for the lifetime of the process.
 *
 * The JWT key material (`CryptoKey` instances produced by
 * `loadKeyPairFromPem`) is also cached, keyed on `JWT_KID` so a
 * rotated key pair naturally evicts the old entry.
 *
 * @see Requirements 1.1, 1.4, 1.5, 2.2, 5.1.
 */

import {
  loadKeyPairFromPem,
  register as svcRegister,
  login as svcLogin,
  refresh as svcRefresh,
  logout as svcLogout,
  deleteMe as svcDeleteMe,
  requestReset as svcRequestReset,
  confirmReset as svcConfirmReset,
  shouldAllowLogin,
  createResetTokenDeriver,
  type AuthServiceDeps,
  type DeliverResetDeps,
  type Jwks,
  type PasswordResetEmailTransport,
  type PasswordResetRepo,
  type Session,
  type SigningKey,
  type UserRepo,
  type SessionStore,
} from '@athlya/auth';

import { noteOutboxWrite } from '../events/outbox-kick.js';
import { buildRoutedPublishDeps } from '../events/publish-deps.js';
import { publish } from '../events/publish.js';

import { createRedisSessionStore } from './auth-session-store-redis.js';
import { createDrizzleUserRepo } from './auth-user-repo-drizzle.js';
import {
  getOrCreateDbHttp,
  getOrCreateRedisForEnv,
  primeDbHttpForTests,
  resetAllDepsCachesForTests,
} from './deps-cache.js';
import { fetchWithRetry } from './fetch-retry.js';
import { createRedisLoginAnomalyStore } from './login-anomaly-store-redis.js';
import {
  createDrizzlePasswordResetRepo,
  createPasswordResetRequestQueue,
  createPasswordResetRequestTokenStore,
} from './password-reset-repo-drizzle.js';
import { queryRows, serviceFn } from './service-functions.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';

import type { AuthDeps, AuthSession } from '../routes/auth.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbHttp } from '@athlya/db/client';
import type { AthlyaEvent } from '@athlya/shared/events';

/* ------------------------------------------------------------------ */
/*  Per-isolate caches                                                 */
/* ------------------------------------------------------------------ */

/**
 * Cache of imported JWT key pairs keyed by `JWT_KID`.
 *
 * `CryptoKey` objects produced by `crypto.subtle.importKey` are plain
 * opaque handles — they do NOT carry per-request I/O state under
 * Cloudflare Workers' isolation rules, so sharing them across
 * requests is both safe and desirable (the PEM import is the most
 * expensive CPU cost on the cold path).
 */
interface JwtState {
  readonly signingKey: SigningKey;
  readonly jwks: Jwks;
}

const jwtCache = new Map<string, JwtState>();

async function getJwtState(
  wider: AthlyaBindings & {
    readonly JWT_KID: string;
    readonly JWT_PRIVATE_KEY_PEM: string;
    readonly JWT_PUBLIC_KEY_PEM: string;
    readonly JWKS_JSON: string;
  },
): Promise<JwtState> {
  const cached = jwtCache.get(wider.JWT_KID);
  if (cached !== undefined) return cached;

  const signingKey = await loadKeyPairFromPem(
    wider.JWT_PRIVATE_KEY_PEM,
    wider.JWT_PUBLIC_KEY_PEM,
    wider.JWT_KID,
  );
  // Parse the JWKS the Worker serves at `/.well-known/jwks.json`.
  // The auth service uses it to verify tokens it mints (e.g. on
  // refresh, the service verifies the presented refresh token
  // before rotating). In this Niveau 2 wiring both ends of the JWT
  // round-trip live in the same process, so pointing the verifier
  // at the same JWKS document avoids one HTTP round-trip per
  // refresh.
  let jwks: Jwks;
  try {
    jwks = JSON.parse(wider.JWKS_JSON) as Jwks;
  } catch (cause) {
    throw new Error('Invalid JWKS_JSON binding — check wrangler secret', { cause });
  }

  const state: JwtState = { signingKey, jwks };
  jwtCache.set(wider.JWT_KID, state);
  return state;
}

/**
 * Test seam — drop every cached handle so a unit test can swap the
 * connection string between calls without seeing the previous one's
 * cached client. Production code paths never call this.
 *
 * Slice B8.2 — the DB + Redis caches are now module-scoped on
 * `deps-cache.ts` and shared across auth/members/reservations. This
 * shim flushes the shared caches plus the auth-only `jwtCache`.
 */
export function __resetAuthDepsCachesForTests(): void {
  resetAllDepsCachesForTests();
  jwtCache.clear();
}

/**
 * @internal Test seam — primes the per-isolate `dbHttpCache` for
 * `url` and reports the resulting cache size. Used by the B1.5
 * integration test to verify that 100 parallel calls share ONE DB
 * handle. Production code paths never call this.
 *
 * Slice B8.2 — delegates to the shared `primeDbHttpForTests` from
 * `deps-cache.ts`. Re-exported here so the B1.5 test's named imports
 * (`primeAuthDb`) keep working.
 */
export function __primeDbHttpForTests(url: string): {
  readonly size: number;
  readonly handle: AthlyaDbHttp;
} {
  return primeDbHttpForTests(url);
}

/* ------------------------------------------------------------------ */
/*  Service deps builder                                               */
/* ------------------------------------------------------------------ */

/**
 * Per-call wiring state. Holds the adapter instances built on top of
 * the cached HTTP DB + Redis clients; the underlying clients are
 * shared across the isolate.
 */
interface AuthServiceState {
  readonly userRepo: UserRepo;
  readonly sessionStore: SessionStore;
  readonly serviceDeps: AuthServiceDeps;
  /**
   * Sprint-7 SP7.4 (Vague 35, finalises S2-006). Optional —
   * `null` when the env doesn't carry a Drizzle handle (e.g.
   * stub mode for low-level middleware tests). Production deploys
   * always have the repo wired.
   */
  readonly passwordResetRepo: PasswordResetRepo | null;
}

/**
 * Assemble the `AuthServiceDeps` bundle for the supplied env.
 *
 * The repository and session-store wrappers are cheap closures over
 * the cached clients, so building them per call is essentially free.
 */
async function getAuthState(env: AthlyaBindings): Promise<AuthServiceState> {
  const db = getOrCreateDbHttp(env.DB_URL);
  const redis = getOrCreateRedisForEnv(env);

  // The Worker's Bindings interface doesn't declare the JWT env
  // keys yet (they were added after task 8.2); widen the type
  // locally so the rest of the codebase keeps its narrow view.
  const wider = env as AthlyaBindings & {
    readonly JWT_KID: string;
    readonly JWT_PRIVATE_KEY_PEM: string;
    readonly JWT_PUBLIC_KEY_PEM: string;
    readonly JWKS_JSON: string;
  };

  const { signingKey, jwks } = await getJwtState(wider);

  const userRepo = createDrizzleUserRepo(db);
  const sessionStore = createRedisSessionStore(redis);

  // Sprint 12 / Slice 12.15 (Epic B3.4) — login anomaly store.
  // Optional dep on `AuthServiceDeps`; when present, the login
  // flow detects geo / UA changes and emits
  // `auth.suspicious.login.anomaly`.
  const loginAnomalyStore = createRedisLoginAnomalyStore(redis);

  // Sprint-7 SP7.4 (Vague 35) — the password-reset repo backs the
  // confirm flow. It is always available when Drizzle is (same
  // envelope as the user repo). The reset email is sent by the
  // outbox consumer (`buildPasswordResetDeliveryDeps`, issue #645).
  const passwordResetRepo = createDrizzlePasswordResetRepo(db);

  const serviceDeps: AuthServiceDeps = {
    userRepo,
    sessionStore,
    signingKey,
    jwks,
    loginAnomalyStore,
    options: {
      jwtIssuer: (env as { JWT_ISSUER?: string }).JWT_ISSUER ?? 'athlya',
      jwtAudience:
        (env as { JWT_AUDIENCE?: string }).JWT_AUDIENCE ?? `athlya-api-${env.ENVIRONMENT}`,
    },
    publishEvent: (event: AthlyaEvent) => buildPublishEvent(env)(event),
    dispatchRecordedEvent: (event: AthlyaEvent) => buildDispatchRecordedEvent(env)(event),
    hibpFailClosed: env.ENVIRONMENT === 'production',
  };

  return {
    userRepo,
    sessionStore,
    serviceDeps,
    passwordResetRepo,
  };
}

/* ------------------------------------------------------------------ */
/*  Auth event publisher (exported for unit testing — issue #411)     */
/* ------------------------------------------------------------------ */

/**
 * Returns a `publishEvent` function bound to the supplied env.
 *
 * Durability policy:
 *   - Compliance-critical events (auth.user.*) are normally recorded by
 *     the user repo together with their mutation and never reach this
 *     function. `auth_record_event` refuses them, so if one does reach it
 *     the outbox write fails and is rethrown: the caller returns 500
 *     rather than emitting a critical event without its durable record.
 *   - Advisory events (auth.suspicious.*): outbox failure is logged at
 *     error level for Sentry; execution continues to the direct queue
 *     publish.
 *
 * The outbox row is written through the `auth_record_event` SECURITY
 * DEFINER function (migration 0033), which works under the NOBYPASSRLS
 * `athlya_app` role without tenant context.
 */
export function buildPublishEvent(env: AthlyaBindings): (event: AthlyaEvent) => Promise<void> {
  const COMPLIANCE_CRITICAL_PREFIXES = ['auth.user.'] as const;

  return async (event: AthlyaEvent) => {
    const isCritical = COMPLIANCE_CRITICAL_PREFIXES.some((p) =>
      (event.type as string).startsWith(p),
    );

    const dbHttp = getOrCreateDbHttp(env.DB_URL);
    try {
      await queryRows(dbHttp, serviceFn.recordAuthEvent(event));
      noteOutboxWrite(event.type);
    } catch (outboxErr) {
      console.error('[auth-deps] publishEvent: outbox write failed', {
        eventId: event.id,
        eventType: event.type,
        critical: isCritical,
        error: outboxErr instanceof Error ? outboxErr.message : String(outboxErr),
      });
      if (isCritical) {
        throw outboxErr;
      }
    }

    // Direct queue publish for low-latency delivery. If this fails the
    // outbox row ensures the drain worker retries on the next cron tick.
    try {
      await publish(event, undefined, buildRoutedPublishDeps(env));
    } catch (err) {
      console.warn(
        '[auth-deps] publishEvent: queue publish failed — drain will retry from outbox',
        {
          eventId: event.id,
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  };
}

/**
 * Queue-only delivery for an event the user repo already recorded in the
 * outbox together with its mutation (issue #411). Never writes the
 * outbox; a queue failure is logged and left to the outbox drain.
 */
export function buildDispatchRecordedEvent(
  env: AthlyaBindings,
): (event: AthlyaEvent) => Promise<void> {
  return async (event: AthlyaEvent) => {
    try {
      await publish(event, undefined, buildRoutedPublishDeps(env));
    } catch (err) {
      console.warn('[auth-deps] dispatchRecordedEvent: queue publish failed — drain will deliver', {
        eventId: event.id,
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Router-level `AuthDeps`                                            */
/* ------------------------------------------------------------------ */

/**
 * Translate a `Session` value returned by the auth service into the
 * loosely-typed `AuthSession` the router forwards to clients.
 */
function toAuthSession(s: Session, now: () => number): AuthSession {
  const nowSec = now();
  return {
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    accessTokenExpiresIn: Math.max(0, s.accessExp - nowSec),
    refreshTokenExpiresIn: Math.max(0, s.refreshExp - nowSec),
    user: {
      id: s.user.id,
      email: s.user.email,
      displayName: s.user.displayName,
      studioId: s.user.studioId,
      role: s.user.role,
    },
  };
}

/**
 * Produce the `AuthDeps` bundle consumed by `buildAuthRouter`.
 *
 * The DB + Redis clients backing every method come from the
 * per-isolate caches above; only the lightweight adapter wrappers
 * are rebuilt per call.
 */
export function buildAuthDeps(env: AthlyaBindings): AuthDeps {
  const now = () => Math.floor(Date.now() / 1000);

  return {
    async register(input) {
      const state = await getAuthState(env);
      const session = await svcRegister(input, state.serviceDeps);
      return toAuthSession(session, now);
    },
    async login(input, ctx) {
      const state = await getAuthState(env);
      // Sprint-1 SP1.2 — Req 1.6 login-attempt throttle. Keyed
      // on `(ip, email)` per the requirement; the API gateway
      // resolves `ctx.ip` from `CF-Connecting-IP` (or the
      // first `X-Forwarded-For` token in non-CF deployments).
      // The decision is forwarded to `svcLogin`, which raises
      // `AuthError('rate_limited')` when `allow === false` —
      // the Problem-Details mapper translates that to HTTP
      // 429 with `Retry-After` automatically.
      const redis = getOrCreateRedisForEnv(env);
      const decision = await shouldAllowLogin(ctx.ip, input.email, {
        redis,
      });
      const session = await svcLogin(input, state.serviceDeps, {
        throttle: decision,
        // Sprint 12 / Slice 12.15 (Epic B3.4) — propagate
        // CF-IPCountry + User-Agent to the anomaly detector
        // when the route handler resolved them from the
        // request headers. Optional: missing values
        // disable detection silently.
        ...(ctx.country !== undefined || ctx.userAgent !== undefined
          ? {
              anomalySignal: {
                country: ctx.country,
                userAgent: ctx.userAgent,
              },
            }
          : {}),
      });
      return toAuthSession(session, now);
    },
    async refresh(input) {
      const state = await getAuthState(env);
      const session = await svcRefresh(input.refreshToken, state.serviceDeps);
      return toAuthSession(session, now);
    },
    async logout(userId, refreshToken) {
      const state = await getAuthState(env);
      if (refreshToken === undefined) {
        // Clients that predate the per-session logout send no
        // refresh token. Revoking every session keeps them from
        // leaving a live refresh token behind after sign-out.
        await state.sessionStore.revokeAllForUser(userId);
        return;
      }
      // Audit finding S2-010 — revoke only the presented session;
      // the user's other devices stay signed in.
      await svcLogout(refreshToken, state.serviceDeps, { userId });
    },
    async logoutAll(userId) {
      // Sprint-4 SP4.1 (S2-010) — explicit "sign out everywhere"
      // endpoint: every live sid of the user is revoked, whereas
      // `logout` revokes only the presented session.
      const state = await getAuthState(env);
      await state.sessionStore.revokeAllForUser(userId);
    },
    async deleteMe(userId) {
      const state = await getAuthState(env);
      await svcDeleteMe(userId, state.serviceDeps);
    },
    async requestPasswordReset(email) {
      // Issue #645 — record the request in the outbox. The token and
      // the email are produced by the notifications consumer
      // (`buildPasswordResetDeliveryDeps`), with the queue's retries
      // and DLQ, so no account-dependent external call runs here.
      await svcRequestReset(email, {
        resetRequests: createPasswordResetRequestQueue(getOrCreateDbHttp(env.DB_URL)),
      });
    },
    async confirmPasswordReset(input) {
      const state = await getAuthState(env);
      if (state.passwordResetRepo === null) {
        // Without the repo we cannot verify the token at
        // all. Surface as `token_invalid` so the route maps
        // to 401 — same envelope as a forged token.
        throw new Error('password_reset_repo_unavailable');
      }
      await svcConfirmReset(input, {
        passwordResetRepo: state.passwordResetRepo,
        sessionStore: state.sessionStore,
        hibpFailClosed: env.ENVIRONMENT === 'production',
      });
    },
    checkPasswordResetRateLimit: async (email: string) => {
      const redis = getOrCreateRedisForEnv(env);
      // Hash the email so Redis never stores raw PII and key
      // cardinality stays bounded (mirrors loginBucketKey, S5-007).
      const data = new TextEncoder().encode(email.toLowerCase().trim());
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24);
      const key = `pw-reset:${hex}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, 86400); // 24h window
      } else if ((await redis.ttl(key)) < 0) {
        // A prior EXPIRE may have failed, leaving the counter with no
        // TTL — re-arm it so a transient error can never turn the
        // window into a permanent lockout.
        await redis.expire(key, 86400);
      }
      return count <= 3;
    },
    idempotencyFor(claims) {
      // Issue #645 — `idempotency_keys` only shows and accepts the
      // caller's own rows (`user_id = app_user_id()`), so every
      // statement runs with the caller's claims.
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), {
          userId: claims.userId,
          studioId: claims.studioId,
          role: claims.role,
        }),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Password-reset delivery — outbox consumer (issue #645)             */
/* ------------------------------------------------------------------ */

/**
 * Dependencies of `deliverResetEmail` for the notifications queue
 * consumer: the user lookup and token issuance go through the
 * SECURITY DEFINER service functions (no tenant claims in a consumer),
 * and the email through the Resend transport below.
 */
export function buildPasswordResetDeliveryDeps(env: AthlyaBindings): DeliverResetDeps {
  const db = getOrCreateDbHttp(env.DB_URL);
  const resetLinkBaseUrl = resolveResetLinkBaseUrl(env);
  const deriveToken = resolveResetTokenDeriver(env);
  return {
    userRepo: createDrizzleUserRepo(db),
    tokens: createPasswordResetRequestTokenStore(db),
    emailTransport: buildPasswordResetEmailTransport(env),
    resetLinkBaseUrl,
    ...(deriveToken !== undefined ? { deriveToken } : {}),
  };
}

/**
 * Per-request token deriver keyed by `PASSWORD_RESET_TOKEN_KEY`. Outside
 * dev a missing key throws: without it a retry would mint a new token and
 * could invalidate a link already delivered. Dev falls back to a random
 * token per attempt.
 */
export function resolveResetTokenDeriver(
  env: AthlyaBindings,
): DeliverResetDeps['deriveToken'] | undefined {
  const key = env.PASSWORD_RESET_TOKEN_KEY;
  if (key !== undefined && key.length > 0) return createResetTokenDeriver(key);
  if (env.ENVIRONMENT === 'dev') return undefined;
  throw new Error(
    `[auth-deps] PASSWORD_RESET_TOKEN_KEY is not configured in ${env.ENVIRONMENT}; ` +
      'password reset emails cannot be delivered',
  );
}

/**
 * Base URL of the reset link. Outside dev a missing `WEB_APP_URL` throws
 * rather than emailing a link to a placeholder host: the message is
 * retried, then dead-lettered, and the error names the binding.
 */
export function resolveResetLinkBaseUrl(env: AthlyaBindings): string {
  const configured = env.WEB_APP_URL;
  if (configured !== undefined && configured.length > 0) return configured;
  if (env.ENVIRONMENT === 'dev') return 'https://app.athlya.test';
  throw new Error(
    `[auth-deps] WEB_APP_URL is not configured in ${env.ENVIRONMENT}; ` +
      'password reset links cannot be built',
  );
}

/* ------------------------------------------------------------------ */
/*  Password-reset email transport — Sprint-7 SP7.4 (Vague 35)         */
/* ------------------------------------------------------------------ */

/**
 * Build the email transport used by the password-reset flow.
 *
 * Two transports are supported:
 *
 *   1. **Resend production transport** — when the env binding
 *      `RESEND_API_KEY` is present, build a transport that POSTs
 *      to `https://api.resend.com/emails`. The `RESEND_API_KEY`
 *      is set per-env via `wrangler secret put RESEND_API_KEY`.
 *      The "from" address defaults to `noreply@athlya.app` and
 *      can be overridden via `RESEND_FROM`.
 *
 *   2. **Dev no-op** — when `RESEND_API_KEY` is absent in `dev`,
 *      the email is dropped with a structured warning that carries
 *      the expiry only: never the link (a bearer credential) nor
 *      the recipient. Use a Resend test key to receive the link
 *      locally. Every other environment rejects, so the queue
 *      retries and dead-letters the delivery instead of losing it.
 *
 * The function returns `null` only when an unrecoverable config
 * error is detected — currently the function ALWAYS returns a
 * non-null transport (either Resend or console). The signature
 * keeps `null` as a future option for "transport refused — refuse
 * the route" if a stricter posture lands.
 */
export function buildPasswordResetEmailTransport(env: AthlyaBindings): PasswordResetEmailTransport {
  const apiKey = env.RESEND_API_KEY;
  const fromAddress = env.RESEND_FROM || 'Athlya <noreply@athlya.app>';

  if (apiKey === undefined || apiKey.length === 0) {
    if (env.ENVIRONMENT !== 'dev') {
      return {
        sendResetEmail() {
          return Promise.reject(
            new Error(
              `[auth-deps] RESEND_API_KEY is not configured in ${env.ENVIRONMENT}. ` +
                'Password reset emails cannot be sent. Set the secret with: ' +
                `wrangler secret put RESEND_API_KEY --env ${env.ENVIRONMENT}`,
            ),
          );
        },
      };
    }
    return {
      sendResetEmail(input) {
        // The link is a bearer credential and the recipient is PII:
        // neither is logged, even in dev (a deploy without `--env`
        // runs with ENVIRONMENT = "dev", issue #645).
        console.warn(
          '[auth-deps] password-reset transport: RESEND_API_KEY missing, email not sent (dev fallback)',
          {
            code: 'reset_email_not_sent',
            expiresAt: input.expiresAt.toISOString(),
          },
        );
        return Promise.resolve();
      },
    };
  }

  return {
    async sendResetEmail(input) {
      // Sprint 12 / Slice 12.1 — wrap the Resend call in
      // retry+jitter+timeout so a transient Cloudflare-edge or
      // Resend hiccup doesn't bubble up as a thrown email
      // failure. Default policy: 2 retries, 5s per-attempt
      // timeout, full jitter. The forgot-password service
      // already swallows transport errors at boundary, so
      // throwing here is a true "Resend-down for >15s" signal.
      //
      // Issue #645 — the body depends on the request only (the link is
      // derived from the request id and the copy carries no timestamp),
      // so a retried send is byte-identical and Resend's
      // `Idempotency-Key` returns the first result instead of emailing
      // the link twice.
      const response = await fetchWithRetry('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(input.idempotencyKey !== undefined
            ? { 'idempotency-key': input.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [input.to],
          subject: '[Athlya] Réinitialisation de votre mot de passe',
          text: [
            'Bonjour,',
            '',
            'Vous avez demandé la réinitialisation de votre mot de passe.',
            'Cliquez sur le lien suivant (valide pendant une heure) :',
            '',
            input.link,
            '',
            "Si vous n'avez pas fait cette demande, ignorez ce message.",
          ].join('\n'),
        }),
      });
      if (!response.ok) {
        throw new Error(
          `password-reset email transport: Resend returned HTTP ${String(response.status)}`,
        );
      }
    },
  };
}

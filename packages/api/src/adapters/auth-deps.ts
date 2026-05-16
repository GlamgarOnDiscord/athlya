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
 *   - Best-effort: publish failures are logged but do NOT fail the
 *     request — the outbox would catch them if we were inside a
 *     transaction, but the auth service emits events AFTER its own
 *     inserts commit so outbox attachment is out of scope here.
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

import { loadKeyPairFromPem, register as svcRegister, login as svcLogin, refresh as svcRefresh, deleteMe as svcDeleteMe, requestReset as svcRequestReset, confirmReset as svcConfirmReset, shouldAllowLogin, type AuthServiceDeps, type Jwks, type PasswordResetEmailTransport, type PasswordResetRepo, type Session, type SigningKey, type UserRepo, type SessionStore } from '@athlya/auth';


import { publish, type Queue } from '../events/publish.js';


import { createRedisSessionStore } from './auth-session-store-redis.js';
import { createDrizzleUserRepo } from './auth-user-repo-drizzle.js';
import {
    getOrCreateDbHttp,
    getOrCreateRedis,
    primeDbHttpForTests,
    resetAllDepsCachesForTests,
} from './deps-cache.js';
import { fetchWithRetry } from './fetch-retry.js';
import { createRedisLoginAnomalyStore } from './login-anomaly-store-redis.js';
import { createDrizzlePasswordResetRepo } from './password-reset-repo-drizzle.js';

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
    /**
     * Sprint-7 SP7.4. Email transport for the reset link. `null`
     * until a Resend (or alternate) transport is wired via env
     * binding. The current scaffold ships a console-log fallback
     * so dev environments can exercise the full flow without
     * actually sending email.
     */
    readonly emailTransport: PasswordResetEmailTransport | null;
    /**
     * Base URL of the web app — used by `requestReset` to
     * construct the email link. Falls back to a placeholder when
     * the binding is absent.
     */
    readonly resetLinkBaseUrl: string;
}

/**
 * Assemble the `AuthServiceDeps` bundle for the supplied env.
 *
 * The repository and session-store wrappers are cheap closures over
 * the cached clients, so building them per call is essentially free.
 */
async function getAuthState(
    env: AthlyaBindings,
): Promise<AuthServiceState> {
    const db = getOrCreateDbHttp(env.DB_URL);
    const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);

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

    // Sprint-7 SP7.4 (Vague 35) — wire the password-reset repo +
    // email transport. The repo is always available when Drizzle is
    // (same envelope as the user repo). The email transport is
    // gated on a `RESEND_API_KEY` binding; until that ships, we
    // fall back to a console-log transport that surfaces the link
    // in dev/staging logs so the flow is exercisable end-to-end.
    const passwordResetRepo = createDrizzlePasswordResetRepo(db);
    const emailTransport = buildPasswordResetEmailTransport(env);
    const resetLinkBaseUrl =
        ((env as { WEB_APP_URL?: string }).WEB_APP_URL?.length ?? 0) > 0
            ? (env as unknown as { WEB_APP_URL: string }).WEB_APP_URL
            : 'https://app.athlya.test';

    const serviceDeps: AuthServiceDeps = {
        userRepo,
        sessionStore,
        signingKey,
        jwks,
        loginAnomalyStore,
        options: {
            jwtIssuer: (env as { JWT_ISSUER?: string }).JWT_ISSUER ?? 'athlya',
            jwtAudience:
                (env as { JWT_AUDIENCE?: string }).JWT_AUDIENCE ??
                `athlya-api-${env.ENVIRONMENT}`,
        },
        publishEvent: async (event: AthlyaEvent) => {
            try {
                await publish(event, undefined, {
                    // FIXME(B8.3): Queue type not exposed by Cloudflare types — investigate
                    queue: env.EVENTS_QUEUE as unknown as Queue,
                });
            } catch (err) {
                // Best-effort only: auth events are published AFTER
                // the repo insert commits, so a queue failure here
                // is a notification delay, not a consistency break.
                // The drain worker (task 9.3) does NOT pick up a
                // missing event on this path — a follow-up slice
                // will move auth events into a transactional outbox
                // insert.
                console.warn('[auth-deps] publishEvent failed', {
                    eventId: event.id,
                    eventType: event.type,
                    error:
                        err instanceof Error ? err.message : String(err),
                });
            }
        },
    };

    return { userRepo, sessionStore, serviceDeps, passwordResetRepo, emailTransport, resetLinkBaseUrl };
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
            const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
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
            const session = await svcRefresh(
                input.refreshToken,
                state.serviceDeps,
            );
            return toAuthSession(session, now);
        },
        async logout(userId) {
            // The router calls logout with the authenticated `userId`
            // (resolved from the Bearer access token by `jwtAuth`),
            // not with the refresh token. The auth service's
            // `logout(refreshToken, deps)` expects a different shape,
            // so we short-circuit to the session store to revoke
            // every live `sid` tied to this user — semantically
            // identical and strictly stronger than revoking the one
            // sid behind the refresh token.
            const state = await getAuthState(env);
            await state.sessionStore.revokeAllForUser(userId);
        },
        async logoutAll(userId) {
            // Sprint-4 SP4.1 (S2-010) — explicit "kick out every
            // device" endpoint. Today's `logout` already calls
            // `revokeAllForUser` (see comment above), so the
            // implementation is identical. The DISTINCTION is on the
            // wire: `/v1/auth/logout-all` is a separate route the
            // user-facing UI exposes via a dedicated CTA ("sign out
            // everywhere"), so the audit log captures the user's
            // explicit intent rather than a routine cookie clear.
            // Should `logout` ever be re-narrowed to a single-sid
            // revoke (per the audit's S2-010 mitigation suggestion),
            // this method keeps the multi-device path live.
            const state = await getAuthState(env);
            await state.sessionStore.revokeAllForUser(userId);
        },
        async deleteMe(userId) {
            const state = await getAuthState(env);
            await svcDeleteMe(userId, state.serviceDeps);
        },
        async requestPasswordReset(email) {
            // Sprint-7 SP7.4 (Vague 35, finalises S2-006). Wire up
            // the password-reset request flow. The PasswordResetRepo
            // adapter and the email transport are produced lazily
            // alongside the rest of the auth state — when either is
            // unavailable (no Drizzle handle, missing email transport
            // binding) we fall back to a no-op log so a misconfigured
            // dev env doesn't crash the route. Production deploys
            // configure both via the bindings doc.
            const state = await getAuthState(env);
            if (state.passwordResetRepo === null || state.emailTransport === null) {
                console.warn('auth.requestPasswordReset: degraded mode — adapters not wired, no email dispatched', {
                    code: 'feature_unavailable',
                });
                return;
            }
            await svcRequestReset(email, {
                userRepo: state.serviceDeps.userRepo,
                passwordResetRepo: state.passwordResetRepo,
                emailTransport: state.emailTransport,
                resetLinkBaseUrl: state.resetLinkBaseUrl,
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
            });
        },
    };
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
 *   2. **Console-log fallback** — when `RESEND_API_KEY` is absent
 *      (e.g. dev without a Resend account, staging during the
 *      first deploy), surface the reset link via a structured
 *      log line so the flow stays exercisable end-to-end. The
 *      log line carries the recipient + link + expiry — fine in
 *      dev, MUST NOT be used in prod (operators would see reset
 *      links in Tail Workers). Production deploys are expected
 *      to set `RESEND_API_KEY` before the route is exposed.
 *
 * The function returns `null` only when an unrecoverable config
 * error is detected — currently the function ALWAYS returns a
 * non-null transport (either Resend or console). The signature
 * keeps `null` as a future option for "transport refused — refuse
 * the route" if a stricter posture lands.
 */
function buildPasswordResetEmailTransport(
    env: AthlyaBindings,
): PasswordResetEmailTransport {
    const apiKey = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
    const fromAddress =
        ((env as { RESEND_FROM?: string }).RESEND_FROM?.length ?? 0) > 0
            ? (env as unknown as { RESEND_FROM: string }).RESEND_FROM
            : 'Athlya <noreply@athlya.app>';

    if (apiKey === undefined || apiKey.length === 0) {
        return {
            sendResetEmail(input) {
                console.warn(
                    '[auth-deps] password-reset transport: RESEND_API_KEY missing, logging link to console (dev fallback)',
                    {
                        recipient: input.to,
                        link: input.link,
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
            const response = await fetchWithRetry(
                'https://api.resend.com/emails',
                {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${apiKey}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: fromAddress,
                        to: [input.to],
                        subject:
                            '[Athlya] Réinitialisation de votre mot de passe',
                        text: [
                            'Bonjour,',
                            '',
                            'Vous avez demandé la réinitialisation de votre mot de passe.',
                            `Cliquez sur le lien suivant (valide jusqu'au ${input.expiresAt.toISOString()}) :`,
                            '',
                            input.link,
                            '',
                            "Si vous n'avez pas fait cette demande, ignorez ce message.",
                        ].join('\n'),
                    }),
                },
            );
            if (!response.ok) {
                throw new Error(
                    `password-reset email transport: Resend returned HTTP ${String(response.status)}`,
                );
            }
        },
    };
}

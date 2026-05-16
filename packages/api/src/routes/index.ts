/**
 * Domain route mount helper — task 8.11 of the Athlya platform spec.
 *
 * Satisfies Requirements 14.1, 14.2 and 20.1 by wiring every `/v1/*`
 * domain router onto the Hono gateway with the correct middleware
 * chain:
 *
 *   • 14.1 — JWT RS256 verification fronts every authenticated route
 *            (every `/v1/*` endpoint EXCEPT the public auth endpoints
 *            `register`, `login`, `refresh`).
 *   • 14.2 — Every request carrying a JSON body, query string or
 *            path params is validated with `zValidator(...)` against
 *            the shared Zod schemas from `@athlya/shared/schemas/api`
 *            before the handler runs.
 *   • 20.1 — Every mutation route (POST / PATCH / PUT / DELETE)
 *            composes the idempotency middleware from task 4.2 so a
 *            retry with the same `Idempotency-Key` replays the
 *            cached response instead of re-executing the mutation.
 *
 * ### Architecture
 *
 * This module is intentionally a thin wiring layer. Each
 * `build<Domain>Router` factory lives in a sibling file
 * (`./auth.ts`, `./members.ts`, …) and accepts a dependency bundle
 * so the routers stay free of direct DB / Redis imports. The
 * concrete services come from `@athlya/auth`, `@athlya/members` and
 * `@athlya/reservations`; the adapters that bind them to production
 * Drizzle / Upstash stores are NOT part of this task — where an
 * epic has not yet shipped its adapter, {@link buildDefaultDeps}
 * returns a `throw new Error('not yet implemented')` stub so task
 * 8.12 integration tests can exercise the routing / 4xx / auth
 * chain without pulling half-finished code.
 *
 * ### Mount order
 *
 * Routers are mounted BEFORE the gateway's `app.notFound(...)` (see
 * `worker.ts`) so unknown `/v1/*` paths still surface the Problem
 * Details 404 envelope. Each router applies its own per-route
 * middleware chain via `app.use('/v1/<path>', middleware)` or by
 * passing middleware inline to the route handler.
 */

import { buildAuthDeps } from '../adapters/auth-deps.js';
import { buildBillingDeps } from '../adapters/billing-deps.js';
import { buildMembersDeps } from '../adapters/members-deps.js';
import {
    buildClassesDeps,
    buildReservationsDeps,
} from '../adapters/reservations-deps.js';
import { buildStudiosDeps } from '../adapters/studios-deps.js';

import { buildAuthRouter, type AuthDeps } from './auth.js';
import { buildBillingRouter, type BillingDeps } from './billing.js';
import { buildCheckinsRouter, type CheckinsDeps } from './checkins.js';
import { buildClassesRouter, type ClassesDeps } from './classes.js';
import { buildMembersRouter, type MembersDeps } from './members.js';
import {
    buildReservationsRouter,
    type ReservationsDeps,
} from './reservations.js';
import { buildSessionsRouter, type SessionsDeps } from './sessions.js';
import { buildStudiosRouter, type StudiosDeps } from './studios.js';

import type { AthlyaBindings, HonoEnv } from '../types.js';
import type { Hono } from 'hono';

export {
    buildAuthRouter,
    buildBillingRouter,
    buildCheckinsRouter,
    buildClassesRouter,
    buildMembersRouter,
    buildReservationsRouter,
    buildSessionsRouter,
    buildStudiosRouter,
};
export type {
    AuthDeps,
    BillingDeps,
    CheckinsDeps,
    ClassesDeps,
    MembersDeps,
    ReservationsDeps,
    SessionsDeps,
    StudiosDeps,
};

/* ------------------------------------------------------------------ */
/*  Deps bundle                                                        */
/* ------------------------------------------------------------------ */

/**
 * Dependency bundle passed to every domain router. Each field is the
 * service bundle for one epic; the adapter layer (wiring it to
 * Drizzle + Upstash + QStash) is the responsibility of
 * {@link buildDefaultDeps}.
 */
export interface DomainDeps {
    readonly auth: AuthDeps;
    readonly members: MembersDeps;
    readonly classes: ClassesDeps;
    readonly reservations: ReservationsDeps;
    readonly sessions: SessionsDeps;
    readonly checkins: CheckinsDeps;
    readonly studios: StudiosDeps;
    readonly billing: BillingDeps;
}

/* ------------------------------------------------------------------ */
/*  mountDomainRoutes                                                  */
/* ------------------------------------------------------------------ */

/**
 * Mount every `/v1/*` domain router onto `app`.
 *
 * Call site: `worker.ts` `buildApp()`, AFTER the global middleware
 * chain (security headers, tracing, logger, OTel, error handlers) is
 * registered and BEFORE `app.notFound(...)`. See task 8.11's
 * architecture note for the exact ordering rationale.
 *
 * @returns the same `app` instance, to allow chaining.
 */
export function mountDomainRoutes(
    app: Hono<HonoEnv>,
    deps: DomainDeps,
): Hono<HonoEnv> {
    app.route('/v1/auth', buildAuthRouter(deps.auth));
    app.route('/v1/members', buildMembersRouter(deps.members));
    app.route('/v1/classes', buildClassesRouter(deps.classes));
    app.route('/v1/reservations', buildReservationsRouter(deps.reservations));
    app.route('/v1/sessions', buildSessionsRouter(deps.sessions));
    app.route('/v1/checkins', buildCheckinsRouter(deps.checkins));
    app.route('/v1/studios', buildStudiosRouter(deps.studios));
    app.route('/v1/billing', buildBillingRouter(deps.billing));
    return app;
}

/* ------------------------------------------------------------------ */
/*  buildDefaultDeps                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the default production dependency bundle from the Worker
 * bindings.
 *
 * The concrete adapters (Drizzle repos, Upstash Redis, QStash, R2)
 * are owned by later tasks:
 *
 *   • Drizzle-backed `UserRepo` / `SessionStore` — Epic 3
 *     persistence adapter (not yet shipped).
 *   • Drizzle-backed `MemberRepo` / `ConsentsRepo` / `ExportJobStore`
 *     — Epic 5 persistence adapter (not yet shipped).
 *   • Drizzle + Redis adapters for `BookingRepo` / `BookingCounter`
 *     / etc. — Epic 6 persistence adapter (not yet shipped).
 *
 * Until those land, every service method is a `throw new Error('not
 * yet implemented')` stub. Task 8.12's integration tests will only
 * exercise routing, auth chain, validation and the 4xx envelopes —
 * domain-level behaviour is covered by each package's own test
 * suite.
 *
 * The signature accepts `env` so production wiring can pass
 * `c.env` straight through once adapters ship.
 */
/**
 * Build a lazy facade over `DomainDeps` — every method call resolves
 * the underlying bundle at invocation time via `resolve()`, forwards
 * the arguments, and returns the result. Combined with a request-
 * scoped `latestEnv` capture in `worker.ts`, this lets the router
 * mount once at boot while the real adapters still read the live
 * Cloudflare `c.env` bindings per request.
 *
 * Every domain field is a small `async (...) => resolve().<method>(...)`
 * passthrough. The two exceptions are:
 *
 *   - `auth.idempotency` — a plain-field reference (NOT a method),
 *     which we forward on each access via a getter so callers see a
 *     live handle.
 *   - Service-free methods (e.g. sync stubs) are wrapped identically;
 *     the async signature is already the contract.
 */
export function buildLazyDomainDeps(
    resolve: () => DomainDeps,
): DomainDeps {
    const forward = <K extends keyof DomainDeps, M extends keyof DomainDeps[K]>(
        domain: K,
        method: M,
    ) => {
        return ((...args: unknown[]) => {
            const real = resolve()[domain][method] as unknown as (
                ...args: unknown[]
            ) => unknown;
            return real.apply(resolve()[domain], args);
        }) as unknown as DomainDeps[K][M];
    };

    return {
        auth: {
            register: forward('auth', 'register'),
            login: forward('auth', 'login'),
            refresh: forward('auth', 'refresh'),
            logout: forward('auth', 'logout'),
            logoutAll: forward('auth', 'logoutAll'),
            deleteMe: forward('auth', 'deleteMe'),
            requestPasswordReset: forward('auth', 'requestPasswordReset'),
            confirmPasswordReset: forward('auth', 'confirmPasswordReset'),
        },
        members: {
            getProfile: forward('members', 'getProfile'),
            updateProfile: forward('members', 'updateProfile'),
            updateConsents: forward('members', 'updateConsents'),
            enqueueExport: forward('members', 'enqueueExport'),
            listMembersByStudio: forward(
                'members',
                'listMembersByStudio',
            ),
        },
        classes: {
            listClasses: forward('classes', 'listClasses'),
            createClass: forward('classes', 'createClass'),
            updateClass: forward('classes', 'updateClass'),
            deleteClass: forward('classes', 'deleteClass'),
        },
        reservations: {
            bookClass: forward('reservations', 'bookClass'),
            cancelReservation: forward(
                'reservations',
                'cancelReservation',
            ),
            listMyReservations: forward(
                'reservations',
                'listMyReservations',
            ),
        },
        sessions: {
            logSession: forward('sessions', 'logSession'),
            listSessions: forward('sessions', 'listSessions'),
        },
        checkins: {
            checkIn: forward('checkins', 'checkIn'),
        },
        studios: {
            getStudio: forward('studios', 'getStudio'),
            updateStudio: forward('studios', 'updateStudio'),
        },
        billing: {
            createCheckoutSession: forward(
                'billing',
                'createCheckoutSession',
            ),
            listInvoices: forward('billing', 'listInvoices'),
            handleWebhook: forward('billing', 'handleWebhook'),
        },
    };
}

const notImplemented = (what: string): never => {
    throw new Error(
        `buildDefaultDeps: ${what} adapter not yet implemented`,
    );
};

/**
 * Build the default production dependency bundle from the Worker
 * bindings.
 *
 * Auth is wired to Drizzle (Neon) + Upstash Redis + the signing key
 * material in `env`. The remaining domains (members, classes,
 * reservations, sessions, checkins) stay on their `not yet
 * implemented` stubs until their own persistence adapters land.
 *
 * The signature accepts `env` so production wiring can pass
 * `c.env` straight through — see `worker.ts` for the per-request
 * capture that keeps the lazy facade alive across Cloudflare's
 * Worker isolate lifecycle.
 */
export function buildDefaultDeps(env: AthlyaBindings): DomainDeps {
    // Sprint-10 SP10.1 (Vague 38, critique C1.1) — fail-fast on
    // missing secrets in production / staging. Pattern 12-factor
    // App: a service MUST refuse to start when its required
    // configuration is absent rather than degrading silently to
    // `not yet implemented` runtime errors that surface only when a
    // user hits an `/v1/auth/*` route. Without this guard, a
    // production deploy with a fumbled secret rotation would still
    // respond 200 to `/health` while every business endpoint fails
    // — the worst kind of partial outage because automated probes
    // miss it.
    //
    // Dev intentionally skips the check so local boot without
    // credentials still works (the stub bundle below kicks in).
    if (env.ENVIRONMENT === 'production' || env.ENVIRONMENT === 'staging') {
        const missing: string[] = [];
        if (typeof env.DB_URL !== 'string' || env.DB_URL.length === 0) {
            missing.push('DB_URL');
        }
        if (typeof env.REDIS_URL !== 'string' || env.REDIS_URL.length === 0) {
            missing.push('REDIS_URL');
        }
        if (typeof env.REDIS_TOKEN !== 'string' || env.REDIS_TOKEN.length === 0) {
            missing.push('REDIS_TOKEN');
        }
        if (typeof env.JWT_JWKS_URL !== 'string' || env.JWT_JWKS_URL.length === 0) {
            missing.push('JWT_JWKS_URL');
        }
        const widerJwt = env as AthlyaBindings & { JWT_KID?: string };
        if (typeof widerJwt.JWT_KID !== 'string' || widerJwt.JWT_KID.length === 0) {
            missing.push('JWT_KID');
        }
        if (missing.length > 0) {
            throw new Error(
                `buildDefaultDeps: missing required secret(s) in ${env.ENVIRONMENT}: ${missing.join(', ')}. The Worker will not start until they are provisioned via 'wrangler secret put'.`,
            );
        }
    }

    // We only enable the auth wiring when the env actually carries
    // the credentials (DB_URL + REDIS_URL + JWT_KID); a placeholder
    // env used by tests / worker bootstrap falls back to the
    // original stub so the test suite behaviour stays unchanged.
    const hasAuthSecrets =
        typeof env.DB_URL === 'string' &&
        env.DB_URL.length > 0 &&
        typeof env.REDIS_URL === 'string' &&
        env.REDIS_URL.length > 0 &&
        typeof (env as AthlyaBindings & { JWT_KID?: string }).JWT_KID ===
        'string' &&
        (env as AthlyaBindings & { JWT_KID: string }).JWT_KID.length > 0;

    const auth: AuthDeps = hasAuthSecrets
        ? buildAuthDeps(env)
        : {
            register: () => notImplemented('auth.register'),
            login: () => notImplemented('auth.login'),
            refresh: () => notImplemented('auth.refresh'),
            logout: () => notImplemented('auth.logout'),
            logoutAll: () => notImplemented('auth.logoutAll'),
            deleteMe: () => notImplemented('auth.deleteMe'),
            requestPasswordReset: () => notImplemented('auth.requestPasswordReset'),
            confirmPasswordReset: () => notImplemented('auth.confirmPasswordReset'),
        };

    // Members reuses the same DB_URL guard as auth — when present it
    // is safe to assume Drizzle is usable; otherwise fall back to
    // the stub bundle so unit tests that boot the worker without
    // Neon credentials keep the integration-chain assertions intact.
    const hasMembersSecrets =
        typeof env.DB_URL === 'string' && env.DB_URL.length > 0;
    const members: MembersDeps = hasMembersSecrets
        ? buildMembersDeps(env)
        : {
            getProfile: () => notImplemented('members.getProfile'),
            updateProfile: () =>
                notImplemented('members.updateProfile'),
            updateConsents: () =>
                notImplemented('members.updateConsents'),
            enqueueExport: () =>
                notImplemented('members.enqueueExport'),
            listMembersByStudio: () =>
                notImplemented('members.listMembersByStudio'),
        };

    // Classes + Reservations read paths need both DB and Redis (the
    // list endpoint joins the remaining-seats counter). The write
    // paths (bookClass / cancelReservation) still throw
    // not_implemented — see `reservations-deps.ts` for scope notes.
    const hasReservationsSecrets =
        hasMembersSecrets &&
        typeof env.REDIS_URL === 'string' &&
        env.REDIS_URL.length > 0;
    const classes = hasReservationsSecrets
        ? buildClassesDeps(env)
        : {
            listClasses: () =>
                notImplemented('reservations.listClasses'),
            createClass: () =>
                notImplemented('reservations.createClass'),
            updateClass: () =>
                notImplemented('reservations.updateClass'),
            deleteClass: () =>
                notImplemented('classes.deleteClass'),
        };
    const reservations = hasReservationsSecrets
        ? buildReservationsDeps(env)
        : {
            bookClass: () =>
                notImplemented('reservations.bookClass'),
            cancelReservation: () =>
                notImplemented('reservations.cancelReservation'),
            listMyReservations: () =>
                notImplemented('reservations.listMyReservations'),
        };

    return {
        auth,
        members,
        classes,
        reservations,
        sessions: {
            logSession: () => notImplemented('members.logSession'),
            listSessions: () =>
                notImplemented('members.listSessions'),
        },
        checkins: {
            checkIn: () => notImplemented('reservations.checkIn'),
        },
        studios: hasMembersSecrets
            ? buildStudiosDeps(env)
            : {
                getStudio: () => notImplemented('studios.getStudio'),
                updateStudio: () =>
                    notImplemented('studios.updateStudio'),
            },
        // Billing is always built — the adapter itself returns
        // mode-dégradé responses (`not_configured`) when STRIPE
        // secrets are absent. No DB / Redis dependency, so the
        // `hasAuthSecrets` guard does not apply.
        billing: buildBillingDeps(env),
    };
}

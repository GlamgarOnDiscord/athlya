/**
 * Production dependency wiring for the `/v1/*` domain routers.
 *
 * Every domain has its own default builder and its own lazy facade, so a
 * bulkhead sub-worker (issue #230) only imports — and only builds at
 * request time — the adapters of the domains it serves. The monolith
 * gateway composes all of them through {@link buildDefaultDeps} and
 * {@link buildLazyDomainDeps}.
 *
 * This module never imports a router: route modules are referenced for
 * their types only, so it stays out of the router dependency graph.
 */

import { buildAuditDeps } from './adapters/audit-deps.js';
import { buildAuthDeps } from './adapters/auth-deps.js';
import { buildBillingDeps } from './adapters/billing-deps.js';
import { buildMembersDeps } from './adapters/members-deps.js';
import { buildClassesDeps, buildReservationsDeps } from './adapters/reservations-deps.js';
import { buildStudiosDeps } from './adapters/studios-deps.js';

import type { AuditDeps } from './routes/audit.js';
import type { AuthDeps } from './routes/auth.js';
import type { BillingDeps } from './routes/billing.js';
import type { CheckinsDeps } from './routes/checkins.js';
import type { ClassesDeps } from './routes/classes.js';
import type { MembersDeps } from './routes/members.js';
import type { ReservationsDeps } from './routes/reservations.js';
import type { SessionsDeps } from './routes/sessions.js';
import type { StudiosDeps } from './routes/studios.js';
import type { AthlyaBindings } from './types.js';

/** Per-request Cloudflare `cf` subset used for EU read-replica routing. */
export type RequestCf = { readonly continent?: string } | undefined;

/**
 * Dependency bundle passed to every domain router. Each field is the
 * service bundle for one epic; the adapter layer (wiring it to
 * Drizzle + Upstash + QStash) is the responsibility of
 * {@link buildDefaultDeps}.
 */
export interface DomainDeps {
  readonly audit: AuditDeps;
  readonly auth: AuthDeps;
  readonly members: MembersDeps;
  readonly classes: ClassesDeps;
  readonly reservations: ReservationsDeps;
  /**
   * Optional — absent until the workout-session adapter ships.
   * Routes are not mounted when undefined (issue #302).
   */
  readonly sessions?: SessionsDeps;
  /**
   * Optional — absent until the check-in adapter ships.
   * Routes are not mounted when undefined (issue #302).
   */
  readonly checkins?: CheckinsDeps;
  readonly studios: StudiosDeps;
  readonly billing: BillingDeps;
}

/* ------------------------------------------------------------------ */
/*  Lazy facades                                                       */
/* ------------------------------------------------------------------ */

/**
 * Returns a factory of passthrough methods: each call resolves the
 * underlying bundle at invocation time via `resolve()` and forwards the
 * arguments. Combined with the request-scoped env capture in
 * `domain-scope.ts`, routers mount once at boot while the real adapters
 * still read the live Cloudflare `c.env` bindings per request.
 */
function forwarder<T>(resolve: () => T) {
  return <M extends keyof T>(method: M): T[M] =>
    ((...args: unknown[]) => {
      const bundle = resolve();
      const real = bundle[method] as unknown as (...args: unknown[]) => unknown;
      return real.apply(bundle, args);
    }) as unknown as T[M];
}

export function lazyAuditDeps(resolve: () => AuditDeps): AuditDeps {
  const forward = forwarder(resolve);
  return { listAuditLog: forward('listAuditLog') };
}

export function lazyAuthDeps(resolve: () => AuthDeps): AuthDeps {
  const forward = forwarder(resolve);
  return {
    register: forward('register'),
    login: forward('login'),
    refresh: forward('refresh'),
    logout: forward('logout'),
    logoutAll: forward('logoutAll'),
    deleteMe: forward('deleteMe'),
    requestPasswordReset: forward('requestPasswordReset'),
    confirmPasswordReset: forward('confirmPasswordReset'),
  };
}

export function lazyMembersDeps(resolve: () => MembersDeps): MembersDeps {
  const forward = forwarder(resolve);
  return {
    getProfile: forward('getProfile'),
    updateProfile: forward('updateProfile'),
    uploadAvatar: forward('uploadAvatar'),
    updateConsents: forward('updateConsents'),
    enqueueExport: forward('enqueueExport'),
    listMembersByStudio: forward('listMembersByStudio'),
  };
}

export function lazyClassesDeps(resolve: () => ClassesDeps): ClassesDeps {
  const forward = forwarder(resolve);
  return {
    listClasses: forward('listClasses'),
    searchClasses: forward('searchClasses'),
    createClass: forward('createClass'),
    updateClass: forward('updateClass'),
    deleteClass: forward('deleteClass'),
  };
}

export function lazyReservationsDeps(resolve: () => ReservationsDeps): ReservationsDeps {
  const forward = forwarder(resolve);
  return {
    bookClass: forward('bookClass'),
    cancelReservation: forward('cancelReservation'),
    listMyReservations: forward('listMyReservations'),
    getRemainingSeats: forward('getRemainingSeats'),
  };
}

export function lazyStudiosDeps(resolve: () => StudiosDeps): StudiosDeps {
  const forward = forwarder(resolve);
  return {
    getStudio: forward('getStudio'),
    updateStudio: forward('updateStudio'),
  };
}

export function lazyBillingDeps(resolve: () => BillingDeps): BillingDeps {
  const forward = forwarder(resolve);
  return {
    createCheckoutSession: forward('createCheckoutSession'),
    listInvoices: forward('listInvoices'),
    handleWebhook: forward('handleWebhook'),
  };
}

/** Lazy facade over the full {@link DomainDeps} bundle (monolith gateway). */
export function buildLazyDomainDeps(resolve: () => DomainDeps): DomainDeps {
  return {
    audit: lazyAuditDeps(() => resolve().audit),
    auth: lazyAuthDeps(() => resolve().auth),
    members: lazyMembersDeps(() => resolve().members),
    classes: lazyClassesDeps(() => resolve().classes),
    reservations: lazyReservationsDeps(() => resolve().reservations),
    studios: lazyStudiosDeps(() => resolve().studios),
    billing: lazyBillingDeps(() => resolve().billing),
  };
}

/* ------------------------------------------------------------------ */
/*  Default (production) builders                                      */
/* ------------------------------------------------------------------ */

const notImplemented = (what: string): never => {
  throw new Error(`buildDefaultDeps: ${what} adapter not yet implemented`);
};

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Sprint-10 SP10.1 (Vague 38, critique C1.1) — fail-fast on missing
 * secrets in production / staging. A service MUST refuse to start when
 * its required configuration is absent rather than degrading silently
 * to `not yet implemented` runtime errors. Dev intentionally skips the
 * check so local boot without credentials still works.
 */
export function assertRequiredSecrets(env: AthlyaBindings): void {
  if (env.ENVIRONMENT !== 'production' && env.ENVIRONMENT !== 'staging') {
    return;
  }
  const missing: string[] = [];
  if (!nonEmpty(env.DB_URL)) missing.push('DB_URL');
  if (!nonEmpty(env.REDIS_URL)) missing.push('REDIS_URL');
  if (!nonEmpty(env.REDIS_TOKEN)) missing.push('REDIS_TOKEN');
  if (!nonEmpty(env.JWT_JWKS_URL)) missing.push('JWT_JWKS_URL');
  if (!nonEmpty((env as AthlyaBindings & { JWT_KID?: string }).JWT_KID)) missing.push('JWT_KID');
  if (missing.length > 0) {
    throw new Error(
      `buildDefaultDeps: missing required secret(s) in ${env.ENVIRONMENT}: ${missing.join(', ')}. The Worker will not start until they are provisioned via 'wrangler secret put'.`,
    );
  }
}

/**
 * Auth is wired to Drizzle (Neon) + Upstash Redis + the signing key
 * material only when the env carries the credentials (DB_URL +
 * REDIS_URL + JWT_KID); a placeholder env used by tests falls back to
 * the stub bundle.
 */
export function defaultAuthDeps(env: AthlyaBindings): AuthDeps {
  const hasAuthSecrets =
    nonEmpty(env.DB_URL) &&
    nonEmpty(env.REDIS_URL) &&
    nonEmpty((env as AthlyaBindings & { JWT_KID?: string }).JWT_KID);

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

  // Fail-fast: idempotency must be wired for all mutation routes in
  // non-dev environments. A missing idempotency dep means duplicate
  // requests (double-click, proxy retry) can create duplicate accounts
  // or trigger double-deletions silently. Issue #460.
  if (auth.idempotency === undefined && env.ENVIRONMENT !== 'dev') {
    throw new Error(
      `[boot] idempotency middleware not wired for environment="${env.ENVIRONMENT}". ` +
        'Ensure DB_URL is set and buildAuthDeps returns an idempotency dep.',
    );
  }
  return auth;
}

/**
 * Members, studios and audit need DB_URL; without it they fall back to
 * the stub bundle so unit tests that boot the worker without Neon
 * credentials keep the integration-chain assertions intact.
 */
export function defaultMembersDeps(env: AthlyaBindings, cf?: RequestCf): MembersDeps {
  return nonEmpty(env.DB_URL)
    ? buildMembersDeps(env, cf)
    : {
        getProfile: () => notImplemented('members.getProfile'),
        updateProfile: () => notImplemented('members.updateProfile'),
        uploadAvatar: () => notImplemented('members.uploadAvatar'),
        updateConsents: () => notImplemented('members.updateConsents'),
        enqueueExport: () => notImplemented('members.enqueueExport'),
        listMembersByStudio: () => notImplemented('members.listMembersByStudio'),
      };
}

export function defaultStudiosDeps(env: AthlyaBindings): StudiosDeps {
  return nonEmpty(env.DB_URL)
    ? buildStudiosDeps(env)
    : {
        getStudio: () => notImplemented('studios.getStudio'),
        updateStudio: () => notImplemented('studios.updateStudio'),
      };
}

export function defaultAuditDeps(env: AthlyaBindings): AuditDeps {
  return nonEmpty(env.DB_URL)
    ? buildAuditDeps(env)
    : { listAuditLog: () => notImplemented('audit.listAuditLog') };
}

/**
 * Classes + Reservations read paths need both DB and Redis (the list
 * endpoint joins the remaining-seats counter).
 */
const hasReservationsSecrets = (env: AthlyaBindings): boolean =>
  nonEmpty(env.DB_URL) && nonEmpty(env.REDIS_URL);

export function defaultClassesDeps(env: AthlyaBindings, cf?: RequestCf): ClassesDeps {
  return hasReservationsSecrets(env)
    ? buildClassesDeps(env, cf)
    : {
        listClasses: () => notImplemented('reservations.listClasses'),
        searchClasses: () => notImplemented('reservations.searchClasses'),
        createClass: () => notImplemented('reservations.createClass'),
        updateClass: () => notImplemented('reservations.updateClass'),
        deleteClass: () => notImplemented('classes.deleteClass'),
      };
}

export function defaultReservationsDeps(env: AthlyaBindings, cf?: RequestCf): ReservationsDeps {
  return hasReservationsSecrets(env)
    ? buildReservationsDeps(env, cf)
    : {
        bookClass: () => notImplemented('reservations.bookClass'),
        cancelReservation: () => notImplemented('reservations.cancelReservation'),
        listMyReservations: () => notImplemented('reservations.listMyReservations'),
        getRemainingSeats: () => notImplemented('reservations.getRemainingSeats'),
      };
}

/**
 * Billing is always built — the adapter itself returns degraded
 * (`not_configured`) responses when STRIPE secrets are absent.
 */
export function defaultBillingDeps(env: AthlyaBindings): BillingDeps {
  return buildBillingDeps(env);
}

/**
 * Build the full production dependency bundle from the Worker bindings
 * (monolith gateway).
 */
export function buildDefaultDeps(env: AthlyaBindings, cf?: RequestCf): DomainDeps {
  assertRequiredSecrets(env);
  return {
    auth: defaultAuthDeps(env),
    members: defaultMembersDeps(env, cf),
    classes: defaultClassesDeps(env, cf),
    reservations: defaultReservationsDeps(env, cf),
    studios: defaultStudiosDeps(env),
    billing: defaultBillingDeps(env),
    audit: defaultAuditDeps(env),
  };
}

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
import { buildCalendarDeps } from './adapters/calendar-deps.js';
import { buildCheckinsDeps } from './adapters/checkins-deps.js';
import { buildCoachDeps } from './adapters/coach-deps.js';
import { buildMembersDeps } from './adapters/members-deps.js';
import { buildProgramsDeps } from './adapters/programs-deps.js';
import { buildClassesDeps, buildReservationsDeps } from './adapters/reservations-deps.js';
import { buildSessionsDeps } from './adapters/sessions-deps.js';
import { buildStudiosDeps } from './adapters/studios-deps.js';

import type { AuditDeps } from './routes/audit.js';
import type { AuthDeps } from './routes/auth.js';
import type { BillingDeps } from './routes/billing.js';
import type { CalendarDeps } from './routes/calendar.js';
import type { CheckinsDeps } from './routes/checkins.js';
import type { ClassesDeps } from './routes/classes.js';
import type { CoachDeps } from './routes/coach.js';
import type { MembersDeps } from './routes/members.js';
import type { ProgramsDeps } from './routes/programs.js';
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
   * Workout sessions (issue #652). Optional so partial test bundles
   * stay valid; production and the lazy facade always provide it.
   */
  readonly sessions?: SessionsDeps;
  /**
   * QR check-in (issue #654). Optional so partial test bundles stay
   * valid; production and the lazy facade always provide it.
   */
  readonly checkins?: CheckinsDeps;
  readonly studios: StudiosDeps;
  readonly billing: BillingDeps;
  /** AI coach (Epic 21), gated by the `ai-coach` feature flag. */
  readonly coach: CoachDeps;
  /**
   * Training programs (Epic 24). Optional so partial test bundles stay
   * valid; production and the lazy facade always provide it.
   */
  readonly programs?: ProgramsDeps;
  /**
   * Member calendar feed (issue #719), gateway only. Optional so partial
   * test bundles stay valid; production and the lazy facade provide it.
   */
  readonly calendar?: CalendarDeps;
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

/**
 * Lazy auth facade. Besides the service methods it carries the optional
 * dependencies of the bundle:
 *
 *   • `checkRefreshRateLimit` / `checkPasswordResetRateLimit` — getters,
 *     so the route's per-request `!== undefined` check sees whether the
 *     resolved bundle provides the throttle.
 *   • `idempotencyFor` — resolved per request with the caller's claims
 *     (issue #645), so a bundle without an idempotency store degrades
 *     to no replay protection instead of failing the mutation.
 */
export function lazyAuthDeps(resolve: () => AuthDeps): AuthDeps {
  const forward = forwarder(resolve);
  const facade: AuthDeps = {
    register: forward('register'),
    login: forward('login'),
    refresh: forward('refresh'),
    logout: forward('logout'),
    logoutAll: forward('logoutAll'),
    deleteMe: forward('deleteMe'),
    requestPasswordReset: forward('requestPasswordReset'),
    confirmPasswordReset: forward('confirmPasswordReset'),
    idempotencyFor: (claims) => resolve().idempotencyFor?.(claims),
  };
  // Getters (not plain optional fields) so `exactOptionalPropertyTypes`
  // still holds: the value is `undefined` only when the bundle omits it.
  Object.defineProperties(facade, {
    checkRefreshRateLimit: {
      enumerable: true,
      get: () => {
        const bundle = resolve();
        return bundle.checkRefreshRateLimit?.bind(bundle);
      },
    },
    checkPasswordResetRateLimit: {
      enumerable: true,
      get: () => {
        const bundle = resolve();
        return bundle.checkPasswordResetRateLimit?.bind(bundle);
      },
    },
  });
  return facade;
}

export function lazyMembersDeps(resolve: () => MembersDeps): MembersDeps {
  const forward = forwarder(resolve);
  return {
    getProfile: forward('getProfile'),
    updateProfile: forward('updateProfile'),
    uploadAvatar: forward('uploadAvatar'),
    updateConsents: forward('updateConsents'),
    enqueueExport: forward('enqueueExport'),
    getExportJob: forward('getExportJob'),
    openExportDownload: forward('openExportDownload'),
    listMembersByStudio: forward('listMembersByStudio'),
    getProgression: forward('getProgression'),
    getCardioProgression: forward('getCardioProgression'),
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
    idempotencyFor: (claims) => resolve().idempotencyFor?.(claims),
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

export function lazyCoachDeps(resolve: () => CoachDeps): CoachDeps {
  const forward = forwarder(resolve);
  return {
    isEnabled: forward('isEnabled'),
    getStatus: forward('getStatus'),
    ask: forward('ask'),
    askStream: forward('askStream'),
  };
}

/**
 * Lazy programs facade. `idempotencyFor` resolves per request, so a
 * bundle without an idempotency store (dev stub) degrades to no replay
 * protection instead of failing the mutation.
 */
export function lazyProgramsDeps(resolve: () => ProgramsDeps): ProgramsDeps {
  const forward = forwarder(resolve);
  return {
    listPrograms: forward('listPrograms'),
    getProgram: forward('getProgram'),
    createProgram: forward('createProgram'),
    updateProgram: forward('updateProgram'),
    archiveProgram: forward('archiveProgram'),
    subscribe: forward('subscribe'),
    unsubscribe: forward('unsubscribe'),
    listMySubscriptions: forward('listMySubscriptions'),
    getToday: forward('getToday'),
    idempotencyFor: (claims) => resolve().idempotencyFor?.(claims),
  };
}

/**
 * Lazy sessions facade. `idempotencyFor` resolves per request, like
 * {@link lazyProgramsDeps}.
 */
export function lazySessionsDeps(resolve: () => SessionsDeps): SessionsDeps {
  const forward = forwarder(resolve);
  return {
    logSession: forward('logSession'),
    listSessions: forward('listSessions'),
    idempotencyFor: (claims) => resolve().idempotencyFor?.(claims),
  };
}

/**
 * Lazy check-in facade. `idempotencyFor` resolves per request, like
 * {@link lazyProgramsDeps}.
 */
export function lazyCheckinsDeps(resolve: () => CheckinsDeps): CheckinsDeps {
  const forward = forwarder(resolve);
  return {
    issueToken: forward('issueToken'),
    checkIn: forward('checkIn'),
    idempotencyFor: (claims) => resolve().idempotencyFor?.(claims),
  };
}

export function lazyCalendarDeps(resolve: () => CalendarDeps): CalendarDeps {
  const forward = forwarder(resolve);
  return {
    getFeedUrl: forward('getFeedUrl'),
    getFeed: forward('getFeed'),
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
    coach: lazyCoachDeps(() => resolve().coach),
    programs: lazyProgramsDeps(() => {
      const programs = resolve().programs;
      if (programs === undefined) {
        throw new Error('buildLazyDomainDeps: programs dependency is not wired');
      }
      return programs;
    }),
    sessions: lazySessionsDeps(() => {
      const sessions = resolve().sessions;
      if (sessions === undefined) {
        throw new Error('buildLazyDomainDeps: sessions dependency is not wired');
      }
      return sessions;
    }),
    checkins: lazyCheckinsDeps(() => {
      const checkins = resolve().checkins;
      if (checkins === undefined) {
        throw new Error('buildLazyDomainDeps: checkins dependency is not wired');
      }
      return checkins;
    }),
    calendar: lazyCalendarDeps(() => {
      const calendar = resolve().calendar;
      if (calendar === undefined) {
        throw new Error('buildLazyDomainDeps: calendar dependency is not wired');
      }
      return calendar;
    }),
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
 * Deployed environments whose Workers must refuse to start without
 * their secrets. Preview Workers are provisioned by
 * `.github/workflows/preview.yml` (issue #611).
 */
const isDeployedEnvironment = (env: AthlyaBindings): boolean =>
  env.ENVIRONMENT === 'production' ||
  env.ENVIRONMENT === 'staging' ||
  env.ENVIRONMENT === 'preview';

/** Signing key bindings `buildAuthDeps` reads besides `JWT_KID` (`getJwtState`). */
type JwtKeyBinding = 'JWT_PRIVATE_KEY_PEM' | 'JWT_PUBLIC_KEY_PEM' | 'JWKS_JSON';

const SIGNING_KEY_BINDINGS: readonly JwtKeyBinding[] = [
  'JWT_PRIVATE_KEY_PEM',
  'JWT_PUBLIC_KEY_PEM',
];

/**
 * Preview also requires `JWKS_JSON`: the workflow writes every preview
 * secret on each deploy, so a missing one is a provisioning bug.
 */
const PREVIEW_JWT_KEY_BINDINGS: readonly JwtKeyBinding[] = [...SIGNING_KEY_BINDINGS, 'JWKS_JSON'];

/**
 * Sprint-10 SP10.1 (Vague 38, critique C1.1) — fail-fast on missing
 * secrets in production / staging / preview. A service MUST refuse to
 * start when its required configuration is absent rather than degrading
 * silently to `not yet implemented` runtime errors. Dev intentionally
 * skips the check so local boot without credentials still works.
 */
export function assertRequiredSecrets(env: AthlyaBindings): void {
  if (!isDeployedEnvironment(env)) {
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
 * The RS256 key pair `buildAuthDeps` signs tokens with. Checked only
 * where auth deps are built, so a Worker that never issues tokens does
 * not depend on the signing material.
 */
function assertSigningKeySecrets(env: AthlyaBindings): void {
  if (!isDeployedEnvironment(env)) {
    return;
  }
  const keys = env as AthlyaBindings & Partial<Record<JwtKeyBinding, string>>;
  const required = env.ENVIRONMENT === 'preview' ? PREVIEW_JWT_KEY_BINDINGS : SIGNING_KEY_BINDINGS;
  const missing = required.filter((name) => !nonEmpty(keys[name]));
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
  assertSigningKeySecrets(env);
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

  // Fail-fast: idempotency must be wired for the authenticated mutation
  // routes in non-dev environments. A missing idempotency dep means
  // duplicate requests (double-click, proxy retry) can trigger
  // double-deletions silently. Issue #460.
  if (auth.idempotencyFor === undefined && env.ENVIRONMENT !== 'dev') {
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
        getExportJob: () => notImplemented('members.getExportJob'),
        openExportDownload: () => notImplemented('members.openExportDownload'),
        listMembersByStudio: () => notImplemented('members.listMembersByStudio'),
        getProgression: () => notImplemented('members.getProgression'),
        getCardioProgression: () => notImplemented('members.getCardioProgression'),
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
 * Programs need DB_URL (the write path falls back to it without
 * Hyperdrive); without it they fall back to the stub bundle.
 */
export function defaultProgramsDeps(env: AthlyaBindings): ProgramsDeps {
  return nonEmpty(env.DB_URL)
    ? buildProgramsDeps(env)
    : {
        listPrograms: () => notImplemented('programs.listPrograms'),
        getProgram: () => notImplemented('programs.getProgram'),
        createProgram: () => notImplemented('programs.createProgram'),
        updateProgram: () => notImplemented('programs.updateProgram'),
        archiveProgram: () => notImplemented('programs.archiveProgram'),
        subscribe: () => notImplemented('programs.subscribe'),
        unsubscribe: () => notImplemented('programs.unsubscribe'),
        listMySubscriptions: () => notImplemented('programs.listMySubscriptions'),
        getToday: () => notImplemented('programs.getToday'),
      };
}

/**
 * Workout sessions need DB_URL (the write path falls back to it
 * without Hyperdrive); without it they fall back to the stub bundle.
 */
export function defaultSessionsDeps(env: AthlyaBindings): SessionsDeps {
  return nonEmpty(env.DB_URL)
    ? buildSessionsDeps(env)
    : {
        logSession: () => notImplemented('sessions.logSession'),
        listSessions: () => notImplemented('sessions.listSessions'),
      };
}

/**
 * QR check-in reads reservations (DB) and consumes token `jti`s in
 * Redis; without both it falls back to the stub bundle. With them, a
 * deployed environment must also carry the signing key pair.
 */
export function defaultCheckinsDeps(env: AthlyaBindings): CheckinsDeps {
  if (nonEmpty(env.DB_URL) && nonEmpty(env.REDIS_URL)) {
    // Token issuance and verification need the RS256 key pair: a
    // deployed Worker without it refuses to start instead of failing
    // every check-in at runtime.
    assertSigningKeySecrets(env);
    return buildCheckinsDeps(env);
  }
  return {
    issueToken: () => notImplemented('checkins.issueToken'),
    checkIn: () => notImplemented('checkins.checkIn'),
  };
}

/**
 * The calendar feed reads users, reservations, classes and studios (DB);
 * without DB_URL it falls back to the stub bundle. A missing signing key
 * is not fatal: the adapter answers `not_configured` (503).
 */
export function defaultCalendarDeps(env: AthlyaBindings, cf?: RequestCf): CalendarDeps {
  return nonEmpty(env.DB_URL)
    ? buildCalendarDeps(env, cf)
    : {
        getFeedUrl: () => notImplemented('calendar.getFeedUrl'),
        getFeed: () => notImplemented('calendar.getFeed'),
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
 * The coach reads sessions and consents (DB) and keeps its daily quota
 * in Redis. Without both, the flag is reported OFF so the stub bundle
 * never answers a request.
 */
export function defaultCoachDeps(env: AthlyaBindings, cf?: RequestCf): CoachDeps {
  return nonEmpty(env.DB_URL) && nonEmpty(env.REDIS_URL)
    ? buildCoachDeps(env, cf)
    : {
        isEnabled: () => Promise.resolve(false),
        getStatus: () => notImplemented('coach.getStatus'),
        ask: () => notImplemented('coach.ask'),
        askStream: () => notImplemented('coach.askStream'),
      };
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
    coach: defaultCoachDeps(env, cf),
    programs: defaultProgramsDeps(env),
    sessions: defaultSessionsDeps(env),
    checkins: defaultCheckinsDeps(env),
    calendar: defaultCalendarDeps(env, cf),
  };
}

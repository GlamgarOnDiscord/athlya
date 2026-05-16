/**
 * Barrel export for `@athlya/api`.
 *
 * Subpath imports (`@athlya/api/middleware/idempotency`) are preferred
 * in downstream packages because they let bundlers skip unused modules
 * entirely. This barrel exists so tests, scripts and documentation can
 * pull everything from a single import path without noticeable bundle
 * cost.
 *
 * Task 8.1 added the Hono gateway surface: the `app` factory and the
 * `HonoEnv` / `AthlyaBindings` / `AthlyaVariables` types. The default
 * Worker export lives in `./worker.ts` and is intentionally NOT re-
 * exported here — it is the Wrangler entrypoint, not part of the
 * library surface. Downstream packages that need to compose routes
 * onto the gateway import the named `app` export below.
 *
 * Note: the sliding-window rate limiter primitive was extracted into
 * `@athlya/ratelimit` as part of hardening H5 to break the
 * `@athlya/api` ↔ `@athlya/auth` circular dependency. Import
 * `rateLimitSlidingWindow` from `@athlya/ratelimit` directly; the
 * rate-limit middleware in this package still re-uses the primitive
 * internally.
 */

export * from './circuit-breaker.js';
export * from './sentry.js';
export * from './middleware/auth.js';
export * from './middleware/idempotency.js';
export * from './middleware/otel.js';
export * from './middleware/problem-details.js';
export * from './middleware/rate-limit.js';
export * from './middleware/security-headers.js';
export * from './middleware/tenant-resolver.js';
export * from './middleware/tenant.js';
export * from './middleware/turnstile.js';
export * from './middleware/validator.js';
export * from './events/publish.js';
export * from './events/drain-dlq.js';
export * from './audit.js';
export * from './logging.js';
export * from './i18n/negotiate.js';
export * from './tracing/ids.js';
export * from './types.js';
export {
    buildAuthRouter,
    buildCheckinsRouter,
    buildClassesRouter,
    buildDefaultDeps,
    buildMembersRouter,
    buildReservationsRouter,
    buildSessionsRouter,
    mountDomainRoutes,
} from './routes/index.js';
export type {
    AuthDeps,
    CheckinsDeps,
    ClassesDeps,
    DomainDeps,
    MembersDeps,
    ReservationsDeps,
    SessionsDeps,
} from './routes/index.js';
export { app, buildApp } from './worker.js';

/**
 * Auth bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/auth/*   — register, login, logout, refresh, password reset
 *
 * /v1/sessions/* (workout sessions) is served by the reservations
 * Worker, next to the members domain (issue #652).
 *
 * Shares the same global middleware chain as the monolith (host check,
 * CORS, tracing, rate limiters, security headers, error handlers) via
 * `buildBaseApp()`. Domain routes are the only addition here.
 *
 * CPU spikes on auth (bcrypt during registration floods, JWKS cold-start
 * latency) are isolated to this Worker's isolate budget and cannot
 * affect reservation or billing latency.
 */

import { buildBaseApp, type ReadinessProbe } from '../base-app.js';
import { assertRequiredSecrets, defaultAuthDeps, lazyAuthDeps } from '../domain-deps.js';
import { installDomainScope } from '../domain-scope.js';
import { buildAuthRouter } from '../routes/auth.js';

/**
 * `/health/ready` probes backed by this Worker's bindings
 * (wrangler.auth.toml): no cron, Hyperdrive or R2 binding, and auth
 * never writes `audit_log`.
 */
export const READINESS: readonly ReadinessProbe[] = ['db', 'redis', 'sentryDsn'];

const app = buildBaseApp({
  readiness: READINESS,
  // Mounted through the base app hook so the routes sit at the same point
  // of the chain as in the monolith, behind the shared /v1/* scope (env
  // capture, BYPASSRLS guard, per-request cf).
  mountDomain: (base) => {
    const resolve = installDomainScope(base, 'auth worker', (env) => {
      assertRequiredSecrets(env);
      return defaultAuthDeps(env);
    });
    base.route('/v1/auth', buildAuthRouter(lazyAuthDeps(resolve)));
  },
});

export { app };

export default {
  fetch: app.fetch.bind(app),
};

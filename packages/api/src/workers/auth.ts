/**
 * Auth bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/auth/*   — register, login, logout, refresh, password reset
 *   • /v1/sessions/* — session list
 *
 * Shares the same global middleware chain as the monolith (host check,
 * CORS, tracing, rate limiters, security headers, error handlers) via
 * `buildBaseApp()`. Domain routes are the only addition here.
 *
 * CPU spikes on auth (bcrypt during registration floods, JWKS cold-start
 * latency) are isolated to this Worker's isolate budget and cannot
 * affect reservation or billing latency.
 */

import { buildBaseApp } from '../worker.js';
import { buildDefaultDeps, buildLazyDomainDeps } from '../routes/index.js';
import { buildAuthRouter } from '../routes/auth.js';
import { buildSessionsRouter } from '../routes/sessions.js';

import type { AthlyaBindings } from '../types.js';

const app = buildBaseApp();

let latestEnv: AthlyaBindings | undefined;
let latestCf: { readonly continent?: string } | undefined;

app.use('/v1/*', async (c, next) => {
  latestEnv = c.env;
  latestCf = (c.req.raw.cf as { continent?: string } | undefined) ?? undefined;
  await next();
});

const lazyDeps = buildLazyDomainDeps(() => {
  if (latestEnv === undefined) {
    throw new Error('auth worker: env not yet captured — /v1/* middleware must run first');
  }
  return buildDefaultDeps(latestEnv, latestCf);
});

app.route('/v1/auth', buildAuthRouter(lazyDeps.auth));
app.route('/v1/sessions', buildSessionsRouter(lazyDeps.sessions));

export { app };

export default {
  fetch: app.fetch.bind(app),
};

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

import { AsyncLocalStorage } from 'node:async_hooks';

import { buildBaseApp } from '../worker.js';
import { buildDefaultDeps, buildLazyDomainDeps } from '../routes/index.js';
import { buildAuthRouter } from '../routes/auth.js';
import { buildSessionsRouter } from '../routes/sessions.js';

import type { AthlyaBindings } from '../types.js';

const app = buildBaseApp();

let latestEnv: AthlyaBindings | undefined;

// Per-request cf via AsyncLocalStorage so concurrent requests in the same
// isolate cannot cross-contaminate the continent routing decision (issue #303).
// latestEnv is safe as a module-scope variable because c.env is the same
// bindings object for every request in one isolate.
const cfStorage = new AsyncLocalStorage<{ readonly continent?: string } | undefined>();

app.use('/v1/*', async (c, next) => {
  latestEnv = c.env;
  const cf = (c.req.raw.cf as { continent?: string } | undefined) ?? undefined;
  await cfStorage.run(cf, () => next());
});

const lazyDeps = buildLazyDomainDeps(() => {
  if (latestEnv === undefined) {
    throw new Error('auth worker: env not yet captured — /v1/* middleware must run first');
  }
  return buildDefaultDeps(latestEnv, cfStorage.getStore());
});

app.route('/v1/auth', buildAuthRouter(lazyDeps.auth));
app.route('/v1/sessions', buildSessionsRouter(lazyDeps.sessions));

export { app };

export default {
  fetch: app.fetch.bind(app),
};

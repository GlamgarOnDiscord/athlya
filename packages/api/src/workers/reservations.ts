/**
 * Reservations bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/classes/*      — list, search, create, update, delete, capacity WS
 *   • /v1/reservations/* — book, cancel, list
 *   • /v1/members/*      — profile, consents, export
 *   • /v1/studios/*      — studio read/update
 *
 * /v1/checkins/* is not mounted — the check-in adapter is not yet
 * implemented. Routes are added once the adapter ships (issue #302).
 *
 * Owns the ClassCapacityDO Durable Object (real-time class capacity via
 * WebSocket). The `[[migrations]]` tag in `wrangler.reservations.toml`
 * ensures the DO namespace is bound to this Worker.
 *
 * A slow reservation cascade or a burst of concurrent booking requests
 * consumes CPU budget only in this Worker's isolate and cannot degrade
 * auth or billing latency.
 */

import { buildBaseApp } from '../worker.js';
import { buildDefaultDeps, buildLazyDomainDeps } from '../routes/index.js';
import { buildCapacityRouter } from '../routes/capacity.js';
import { buildClassesRouter } from '../routes/classes.js';
import { buildMembersRouter } from '../routes/members.js';
import { buildReservationsRouter } from '../routes/reservations.js';
import { buildStudiosRouter } from '../routes/studios.js';

import type { AthlyaBindings } from '../types.js';

export { ClassCapacityDO } from '../durable-objects/class-capacity.js';

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
    throw new Error('reservations worker: env not yet captured — /v1/* middleware must run first');
  }
  return buildDefaultDeps(latestEnv, latestCf);
});

// Capacity WebSocket mounts first: /v1/classes/:classId/capacity/ws must
// be matched before the authenticated classes router so the public WS
// upgrade path is not shadowed by the JWT guard on the class CRUD routes.
app.route('/v1/classes', buildCapacityRouter());
app.route('/v1/classes', buildClassesRouter(lazyDeps.classes));
app.route('/v1/reservations', buildReservationsRouter(lazyDeps.reservations));
app.route('/v1/members', buildMembersRouter(lazyDeps.members));
app.route('/v1/studios', buildStudiosRouter(lazyDeps.studios));

export { app };

export default {
  fetch: app.fetch.bind(app),
};

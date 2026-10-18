/**
 * Reservations bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/classes/*      — list, search, create, update, delete, capacity WS
 *   • /v1/reservations/* — book, cancel, list
 *   • /v1/members/*      — profile, consents, export
 *   • /v1/studios/*      — studio read/update
 *
 * /v1/checkins/* is not routed to this Worker: the check-in adapter is
 * not implemented yet (issue #302), so its wrangler route was removed.
 *
 * Owns the ClassCapacityDO Durable Object (real-time class capacity via
 * WebSocket). The `[[migrations]]` tag in `wrangler.reservations.toml`
 * ensures the DO namespace is bound to this Worker.
 *
 * A slow reservation cascade or a burst of concurrent booking requests
 * consumes CPU budget only in this Worker's isolate and cannot degrade
 * auth or billing latency.
 */

import { buildBaseApp, type ReadinessProbe } from '../base-app.js';
import {
  assertRequiredSecrets,
  defaultClassesDeps,
  defaultMembersDeps,
  defaultReservationsDeps,
  defaultStudiosDeps,
  lazyClassesDeps,
  lazyMembersDeps,
  lazyReservationsDeps,
  lazyStudiosDeps,
} from '../domain-deps.js';
import { installDomainScope } from '../domain-scope.js';
import { buildCapacityRouter } from '../routes/capacity.js';
import { buildClassesRouter } from '../routes/classes.js';
import { buildMembersRouter } from '../routes/members.js';
import { buildReservationsRouter } from '../routes/reservations.js';
import { buildStudiosRouter } from '../routes/studios.js';

export { ClassCapacityDO } from '../durable-objects/class-capacity.js';

/**
 * `/health/ready` probes backed by this Worker's bindings
 * (wrangler.reservations.toml): Hyperdrive serves the write path,
 * /v1/members/* reads the avatar and export R2 buckets, and consent
 * updates on /v1/members/* append to `audit_log`. No cron binding.
 */
export const READINESS: readonly ReadinessProbe[] = [
  'db',
  'redis',
  'hyperdrive',
  'avatarsBucket',
  'exportsBucket',
  'auditLogPartitions',
  'sentryDsn',
];

const app = buildBaseApp({
  readiness: READINESS,
  // Mounted through the base app hook so the routes sit at the same point
  // of the chain as in the monolith, behind the shared /v1/* scope (env
  // capture, BYPASSRLS guard, per-request cf).
  mountDomain: (base) => {
    const resolve = installDomainScope(base, 'reservations worker', (env, cf) => {
      assertRequiredSecrets(env);
      return {
        classes: defaultClassesDeps(env, cf),
        reservations: defaultReservationsDeps(env, cf),
        members: defaultMembersDeps(env, cf),
        studios: defaultStudiosDeps(env),
      };
    });
    // Capacity WebSocket mounts first: /v1/classes/:classId/capacity/ws
    // must match before the JWT-guarded classes router shadows it.
    base.route('/v1/classes', buildCapacityRouter());
    base.route('/v1/classes', buildClassesRouter(lazyClassesDeps(() => resolve().classes)));
    base.route(
      '/v1/reservations',
      buildReservationsRouter(lazyReservationsDeps(() => resolve().reservations)),
    );
    base.route('/v1/members', buildMembersRouter(lazyMembersDeps(() => resolve().members)));
    base.route('/v1/studios', buildStudiosRouter(lazyStudiosDeps(() => resolve().studios)));
  },
});

export { app };

export default {
  fetch: app.fetch.bind(app),
};

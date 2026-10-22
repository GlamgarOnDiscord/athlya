/**
 * Reservations bulkhead Worker entry point (issue #230, CN.6.3).
 *
 * Handles:
 *   • /v1/classes/*      — list, search, create, update, delete, capacity WS
 *   • /v1/classes/rooms/*, /v1/classes/series/*: rooms and weekly series (issue #748)
 *   • /v1/reservations/* — book, cancel, list
 *   • /v1/members/*      — profile, consents, export
 *   • /v1/me/*           — progression (served from the members deps)
 *   • /v1/coach, /v1/coach/* — AI coach (Epic 21, `ai-coach` flag)
 *   • /v1/studios/*      — studio read/update
 *   • /v1/studios/me/settings, /v1/studios/me/webhooks: settings and webhooks (#759, #760)
 *   • /v1/programs/*     — training programs, subscriptions, daily workout
 *   • /v1/studios/me/team/*: studio team and invitations (issue #756)
 *   • /v1/sessions, /v1/sessions/* — workout session log and history (issue #652)
 *   • /v1/checkins, /v1/checkins/* — QR check-in token and kiosk scan (issue #654)
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
  defaultCheckinsDeps,
  defaultClassesDeps,
  defaultClassPlanningDeps,
  defaultCoachDeps,
  defaultMembersDeps,
  defaultProgramsDeps,
  defaultReservationsDeps,
  defaultSessionsDeps,
  defaultStudioSettingsDeps,
  defaultStudiosDeps,
  defaultTeamDeps,
  defaultWebhooksDeps,
  lazyCheckinsDeps,
  lazyClassesDeps,
  lazyClassPlanningDeps,
  lazyCoachDeps,
  lazyMembersDeps,
  lazyProgramsDeps,
  lazyReservationsDeps,
  lazySessionsDeps,
  lazyStudioSettingsDeps,
  lazyStudiosDeps,
  lazyTeamDeps,
  lazyWebhooksDeps,
} from '../domain-deps.js';
import { installDomainScope } from '../domain-scope.js';
import { buildCapacityRouter } from '../routes/capacity.js';
import { buildCheckinsRouter } from '../routes/checkins.js';
import { buildClassSeriesRouter, buildRoomsRouter } from '../routes/class-planning.js';
import { buildClassesRouter } from '../routes/classes.js';
import { buildCoachRouter } from '../routes/coach.js';
import { buildMeRouter } from '../routes/me.js';
import { buildMembersRouter } from '../routes/members.js';
import { buildProgramsRouter } from '../routes/programs.js';
import { buildReservationsRouter } from '../routes/reservations.js';
import { buildSessionsRouter } from '../routes/sessions.js';
import { buildStudioSettingsRouter } from '../routes/studio-settings.js';
import { buildStudiosRouter } from '../routes/studios.js';
import { buildTeamRouter } from '../routes/team.js';
import { buildWebhooksRouter } from '../routes/webhooks.js';

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
        coach: defaultCoachDeps(env, cf),
        programs: defaultProgramsDeps(env),
        sessions: defaultSessionsDeps(env),
        checkins: defaultCheckinsDeps(env),
        studioSettings: defaultStudioSettingsDeps(env),
        webhooks: defaultWebhooksDeps(env),
        team: defaultTeamDeps(env),
        planning: defaultClassPlanningDeps(env),
      };
    });
    // Capacity WebSocket mounts first: /v1/classes/:classId/capacity/ws
    // must match before the JWT-guarded classes router shadows it.
    base.route('/v1/classes', buildCapacityRouter());
    // Rooms and series (issue #748) must match before the classes router's `/:id` routes.
    const planning = lazyClassPlanningDeps(() => resolve().planning);
    base.route('/v1/classes/rooms', buildRoomsRouter(planning));
    base.route('/v1/classes/series', buildClassSeriesRouter(planning));
    base.route('/v1/classes', buildClassesRouter(lazyClassesDeps(() => resolve().classes)));
    base.route(
      '/v1/reservations',
      buildReservationsRouter(lazyReservationsDeps(() => resolve().reservations)),
    );
    const members = lazyMembersDeps(() => resolve().members);
    base.route('/v1/members', buildMembersRouter(members));
    base.route('/v1/me', buildMeRouter(members));
    base.route(
      '/v1/studios/me/settings',
      buildStudioSettingsRouter(lazyStudioSettingsDeps(() => resolve().studioSettings)),
    );
    base.route(
      '/v1/studios/me/webhooks',
      buildWebhooksRouter(lazyWebhooksDeps(() => resolve().webhooks)),
    );
    base.route('/v1/studios/me/team', buildTeamRouter(lazyTeamDeps(() => resolve().team)));
    base.route('/v1/studios', buildStudiosRouter(lazyStudiosDeps(() => resolve().studios)));
    base.route('/v1/coach', buildCoachRouter(lazyCoachDeps(() => resolve().coach)));
    base.route('/v1/programs', buildProgramsRouter(lazyProgramsDeps(() => resolve().programs)));
    base.route('/v1/sessions', buildSessionsRouter(lazySessionsDeps(() => resolve().sessions)));
    base.route('/v1/checkins', buildCheckinsRouter(lazyCheckinsDeps(() => resolve().checkins)));
  },
});

export { app };

export default {
  fetch: app.fetch.bind(app),
};

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

import { buildAuditRouter, type AuditDeps } from './audit.js';
import { buildAuthRouter, type AuthDeps } from './auth.js';
import { buildBillingRouter, type BillingDeps } from './billing.js';
import { buildCalendarRouter, type CalendarDeps } from './calendar.js';
import { buildCapacityRouter } from './capacity.js';
import { buildCheckinsRouter, type CheckinsDeps } from './checkins.js';
import {
  buildClassSeriesRouter,
  buildRoomsRouter,
  type ClassPlanningDeps,
} from './class-planning.js';
import { buildClassesRouter, type ClassesDeps } from './classes.js';
import { buildCoachRouter, type CoachDeps } from './coach.js';
import { buildMeRouter, type MeDeps } from './me.js';
import { buildMembersRouter, type MembersDeps } from './members.js';
import { buildProgramsRouter, type ProgramsDeps } from './programs.js';
import { buildReservationsRouter, type ReservationsDeps } from './reservations.js';
import { buildSessionsRouter, type SessionsDeps } from './sessions.js';
import { buildStudioSettingsRouter, type StudioSettingsDeps } from './studio-settings.js';
import { buildStudiosRouter, type StudiosDeps } from './studios.js';
import { buildTeamRouter, type TeamDeps } from './team.js';
import { buildWebhooksRouter, type WebhooksDeps } from './webhooks.js';

import type { DomainDeps } from '../domain-deps.js';
import type { HonoEnv } from '../types.js';
import type { Hono } from 'hono';

export {
  buildAuditRouter,
  buildAuthRouter,
  buildBillingRouter,
  buildCalendarRouter,
  buildCapacityRouter,
  buildCheckinsRouter,
  buildClassesRouter,
  buildClassSeriesRouter,
  buildCoachRouter,
  buildMeRouter,
  buildMembersRouter,
  buildProgramsRouter,
  buildReservationsRouter,
  buildRoomsRouter,
  buildSessionsRouter,
  buildStudioSettingsRouter,
  buildStudiosRouter,
  buildTeamRouter,
  buildWebhooksRouter,
};
export { buildDefaultDeps, buildLazyDomainDeps } from '../domain-deps.js';
export type { DomainDeps } from '../domain-deps.js';
export type {
  AuditDeps,
  AuthDeps,
  BillingDeps,
  CalendarDeps,
  CheckinsDeps,
  ClassesDeps,
  ClassPlanningDeps,
  CoachDeps,
  MeDeps,
  MembersDeps,
  ProgramsDeps,
  ReservationsDeps,
  SessionsDeps,
  StudioSettingsDeps,
  StudiosDeps,
  TeamDeps,
  WebhooksDeps,
};

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
export function mountDomainRoutes(app: Hono<HonoEnv>, deps: DomainDeps): Hono<HonoEnv> {
  app.route('/v1/audit', buildAuditRouter(deps.audit));
  app.route('/v1/auth', buildAuthRouter(deps.auth));
  app.route('/v1/members', buildMembersRouter(deps.members));
  app.route('/v1/me', buildMeRouter(deps.members));
  app.route('/v1/coach', buildCoachRouter(deps.coach));
  // Capacity WebSocket must mount before the authenticated classes router
  // so the public /v1/classes/:classId/capacity/ws path is matched first.
  app.route('/v1/classes', buildCapacityRouter());
  // Rooms and series (issue #748) sit under /v1/classes and mount before
  // the classes router, whose `/:id` routes would otherwise see them.
  if (deps.planning !== undefined) {
    app.route('/v1/classes/rooms', buildRoomsRouter(deps.planning));
    app.route('/v1/classes/series', buildClassSeriesRouter(deps.planning));
  }
  app.route('/v1/classes', buildClassesRouter(deps.classes));
  app.route('/v1/reservations', buildReservationsRouter(deps.reservations));
  if (deps.sessions !== undefined) {
    app.route('/v1/sessions', buildSessionsRouter(deps.sessions));
  }
  if (deps.checkins !== undefined) {
    app.route('/v1/checkins', buildCheckinsRouter(deps.checkins));
  }
  if (deps.studioSettings !== undefined) {
    app.route('/v1/studios/me/settings', buildStudioSettingsRouter(deps.studioSettings));
  }
  if (deps.webhooks !== undefined) {
    app.route('/v1/studios/me/webhooks', buildWebhooksRouter(deps.webhooks));
  }
  if (deps.team !== undefined) {
    app.route('/v1/studios/me/team', buildTeamRouter(deps.team));
  }
  app.route('/v1/studios', buildStudiosRouter(deps.studios));
  app.route('/v1/billing', buildBillingRouter(deps.billing));
  if (deps.programs !== undefined) {
    app.route('/v1/programs', buildProgramsRouter(deps.programs));
  }
  if (deps.calendar !== undefined) {
    app.route('/v1/calendar', buildCalendarRouter(deps.calendar));
  }
  return app;
}

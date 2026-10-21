/**
 * Studio planning routers (issue #748): rooms and weekly class series,
 * mounted under the `/v1/classes/*` prefix the reservations Worker
 * already owns, before the classes router.
 *
 *   | Method | Path                          | Role  | Notes                                   |
 *   |--------|-------------------------------|-------|-----------------------------------------|
 *   | GET    | /v1/classes/rooms             | any   | live rooms of the caller's studio        |
 *   | POST   | /v1/classes/rooms             | admin | 409 `room_name_taken`                    |
 *   | PATCH  | /v1/classes/rooms/:roomId     | admin | 404, 409 `room_name_taken`               |
 *   | DELETE | /v1/classes/rooms/:roomId     | admin | soft delete, unassigns upcoming classes  |
 *   | POST   | /v1/classes/series            | admin | 409 `schedule_conflict`, 422 recurrence  |
 *   | PATCH  | /v1/classes/series/:seriesId  | admin | this and later occurrences, `version`    |
 *   | DELETE | /v1/classes/series/:seriesId  | admin | `?fromClassId=`, this and later ones     |
 *
 * Every route is behind `jwtAuth` and the per-studio burst cap, like the
 * classes router. Mutations go through the tenant-bound idempotency
 * store when the environment provides one.
 *
 * A 409 `schedule_conflict` lists the clashing classes; the client asks
 * the admin and resends with `allowConflicts: true` to schedule anyway.
 */

import {
  CreateClassSeriesRequestSchema,
  CreateRoomRequestSchema,
  DeleteClassSeriesQuerySchema,
  UpdateClassSeriesRequestSchema,
  UpdateRoomRequestSchema,
} from '@athlya/shared/schemas/api';
import { Hono } from 'hono';
import { z } from 'zod';

import { jwtAuth } from '../middleware/auth.js';
import { studioRateLimit } from '../middleware/studio-rate-limit.js';
import { zValidator } from '../middleware/validator.js';

import { idempotency, readValidated, requireRole, traceOperation } from './helpers.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../middleware/idempotency.js';
import type { HonoEnv } from '../types.js';
import type {
  CreateClassSeriesRequest,
  CreateRoomRequest,
  DeleteClassSeriesQuery,
  Room,
  ScheduleConflictItem,
  UpdateClassSeriesRequest,
  UpdateRoomRequest,
} from '@athlya/shared/schemas/api';
import type { Class } from '@athlya/shared/schemas/domain';
import type { Context, MiddlewareHandler } from 'hono';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

export type RoomOutcome =
  | { readonly kind: 'ok'; readonly room: Room }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'name_taken' };

/** Shared by every route that places a class: the room is gone, or the slot is taken. */
export type PlacementRefusal =
  | { readonly kind: 'room_not_found' }
  | { readonly kind: 'schedule_conflict'; readonly conflicts: ReadonlyArray<ScheduleConflictItem> };

export type CreateSeriesResult =
  | { readonly kind: 'created'; readonly seriesId: string; readonly items: ReadonlyArray<Class> }
  | { readonly kind: 'starts_at_in_past' }
  | {
      readonly kind: 'invalid_recurrence';
      readonly reason: 'no_occurrences' | 'too_many_occurrences';
    }
  | PlacementRefusal;

export type UpdateSeriesResult =
  | { readonly kind: 'updated'; readonly items: ReadonlyArray<Class> }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'version_conflict' }
  | { readonly kind: 'class_already_started' }
  | { readonly kind: 'starts_at_in_past' }
  | { readonly kind: 'capacity_below_confirmed'; readonly classId: string }
  | PlacementRefusal;

export type DeleteSeriesResult =
  { readonly kind: 'deleted'; readonly count: number } | { readonly kind: 'not_found' };

/** Dependencies injected into {@link buildRoomsRouter} and {@link buildClassSeriesRouter}. */
export interface ClassPlanningDeps {
  listRooms(claims: AuthClaims): Promise<ReadonlyArray<Room>>;
  createRoom(claims: AuthClaims, input: CreateRoomRequest): Promise<RoomOutcome>;
  updateRoom(claims: AuthClaims, roomId: string, patch: UpdateRoomRequest): Promise<RoomOutcome>;
  deleteRoom(
    claims: AuthClaims,
    roomId: string,
  ): Promise<{ readonly kind: 'deleted' | 'not_found' }>;
  createSeries(claims: AuthClaims, input: CreateClassSeriesRequest): Promise<CreateSeriesResult>;
  updateSeries(
    claims: AuthClaims,
    seriesId: string,
    patch: UpdateClassSeriesRequest,
  ): Promise<UpdateSeriesResult>;
  deleteSeries(
    claims: AuthClaims,
    seriesId: string,
    fromClassId: string,
  ): Promise<DeleteSeriesResult>;
  /** Tenant-bound idempotency store, or `undefined` to run mutations without replay protection. */
  idempotencyFor?(claims: AuthClaims): IdempotencyMiddlewareDeps | undefined;
}

/* ------------------------------------------------------------------ */
/*  Problem Details                                                    */
/* ------------------------------------------------------------------ */

type ProblemStatus = 404 | 409 | 422;

const TITLES: Record<ProblemStatus, string> = {
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};

function problem(
  c: Context<HonoEnv>,
  status: ProblemStatus,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return c.body(
    JSON.stringify({
      type: 'about:blank',
      title: TITLES[status],
      status,
      detail,
      code,
      traceId: c.get('traceId'),
      ...extra,
    }),
    status,
    { 'content-type': 'application/problem+json' },
  );
}

/** 409 `schedule_conflict` with the clashing classes, shared with the classes router. */
export function scheduleConflictProblem(
  c: Context<HonoEnv>,
  conflicts: ReadonlyArray<ScheduleConflictItem>,
): Response {
  return problem(
    c,
    409,
    'schedule_conflict',
    'the room or the coach is already booked at that time; resend with allowConflicts to schedule anyway',
    { conflicts },
  );
}

/** 422 `room_not_found`: the room is not a live room of the caller's studio. */
export function roomNotFoundProblem(c: Context<HonoEnv>): Response {
  return problem(c, 422, 'room_not_found', 'the room does not exist in this studio');
}

/** The response for a {@link PlacementRefusal}. */
export function placementProblem(c: Context<HonoEnv>, refusal: PlacementRefusal): Response {
  return refusal.kind === 'room_not_found'
    ? roomNotFoundProblem(c)
    : scheduleConflictProblem(c, refusal.conflicts);
}

function claimsOf(c: Context<HonoEnv>): AuthClaims {
  const claims = c.get('authClaims');
  if (claims === undefined) {
    throw new Error('authClaims unexpectedly missing after jwtAuth');
  }
  return claims;
}

function idempotencyFor(deps: ClassPlanningDeps): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const store = deps.idempotencyFor?.(claimsOf(c));
    if (store === undefined) {
      await next();
      return;
    }
    return idempotency(store)(c, next);
  };
}

/* ------------------------------------------------------------------ */
/*  Rooms                                                              */
/* ------------------------------------------------------------------ */

const RoomIdParamSchema = z.object({ roomId: z.uuid() }).strict();
const SeriesIdParamSchema = z.object({ seriesId: z.uuid() }).strict();

function roomResponse(c: Context<HonoEnv>, outcome: RoomOutcome, status: 200 | 201): Response {
  switch (outcome.kind) {
    case 'ok':
      return c.json(outcome.room, status);
    case 'not_found':
      return problem(c, 404, 'not_found', 'room not found');
    case 'name_taken':
      return problem(
        c,
        409,
        'room_name_taken',
        'another room of this studio already has that name',
      );
  }
}

/** Build the `/v1/classes/rooms/*` sub-router. */
export function buildRoomsRouter(deps: ClassPlanningDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = idempotencyFor(deps);

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);

  router.get('/', async (c) => {
    traceOperation(c, 'rooms.list');
    const items = await deps.listRooms(claimsOf(c));
    return c.json({ items: [...items] }, 200);
  });

  router.post(
    '/',
    requireRole('admin'),
    zValidator('json', CreateRoomRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'rooms.create');
      const body = readValidated<CreateRoomRequest>(c, 'json');
      return roomResponse(c, await deps.createRoom(claimsOf(c), body), 201);
    },
  );

  router.patch(
    '/:roomId',
    requireRole('admin'),
    zValidator('param', RoomIdParamSchema),
    zValidator('json', UpdateRoomRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'rooms.update');
      const { roomId } = readValidated<z.infer<typeof RoomIdParamSchema>>(c, 'param');
      const patch = readValidated<UpdateRoomRequest>(c, 'json');
      return roomResponse(c, await deps.updateRoom(claimsOf(c), roomId, patch), 200);
    },
  );

  router.delete(
    '/:roomId',
    requireRole('admin'),
    zValidator('param', RoomIdParamSchema),
    async (c) => {
      traceOperation(c, 'rooms.delete');
      const { roomId } = readValidated<z.infer<typeof RoomIdParamSchema>>(c, 'param');
      const outcome = await deps.deleteRoom(claimsOf(c), roomId);
      if (outcome.kind === 'not_found') return problem(c, 404, 'not_found', 'room not found');
      return c.body(null, 204);
    },
  );

  return router;
}

/* ------------------------------------------------------------------ */
/*  Series                                                             */
/* ------------------------------------------------------------------ */

const STARTS_AT_IN_PAST = 'every occurrence must start in the future';

/** Build the `/v1/classes/series/*` sub-router. */
export function buildClassSeriesRouter(deps: ClassPlanningDeps): Hono<HonoEnv> {
  const router = new Hono<HonoEnv>();
  const idem = idempotencyFor(deps);

  router.use('*', jwtAuth());
  router.use('*', studioRateLimit() as Parameters<typeof router.use>[1]);
  router.use('*', requireRole('admin'));

  router.post('/', zValidator('json', CreateClassSeriesRequestSchema), idem, async (c) => {
    traceOperation(c, 'classes.series.create');
    const body = readValidated<CreateClassSeriesRequest>(c, 'json');
    const outcome = await deps.createSeries(claimsOf(c), body);
    switch (outcome.kind) {
      case 'created':
        return c.json({ seriesId: outcome.seriesId, items: [...outcome.items] }, 201);
      case 'starts_at_in_past':
        return problem(c, 422, 'starts_at_in_past', STARTS_AT_IN_PAST);
      case 'invalid_recurrence':
        return problem(
          c,
          422,
          outcome.reason,
          outcome.reason === 'no_occurrences'
            ? 'the repetition yields no occurrence'
            : 'the repetition yields more occurrences than a series may hold',
        );
      case 'room_not_found':
      case 'schedule_conflict':
        return placementProblem(c, outcome);
    }
  });

  router.patch(
    '/:seriesId',
    zValidator('param', SeriesIdParamSchema),
    zValidator('json', UpdateClassSeriesRequestSchema),
    idem,
    async (c) => {
      traceOperation(c, 'classes.series.update');
      const { seriesId } = readValidated<z.infer<typeof SeriesIdParamSchema>>(c, 'param');
      const patch = readValidated<UpdateClassSeriesRequest>(c, 'json');
      const outcome = await deps.updateSeries(claimsOf(c), seriesId, patch);
      switch (outcome.kind) {
        case 'updated':
          return c.json({ items: [...outcome.items] }, 200);
        case 'not_found':
          return problem(c, 404, 'not_found', 'class not found in this series');
        case 'version_conflict':
          return problem(c, 409, 'version_conflict', 'class version mismatch, refetch and retry');
        case 'class_already_started':
          return problem(
            c,
            409,
            'class_already_started',
            'the class already started; edit a later occurrence',
          );
        case 'starts_at_in_past':
          return problem(c, 422, 'starts_at_in_past', STARTS_AT_IN_PAST);
        case 'capacity_below_confirmed':
          return problem(
            c,
            409,
            'capacity_below_confirmed',
            'capacity cannot be lowered below the confirmed reservations and held seats of an occurrence',
            { classId: outcome.classId },
          );
        case 'room_not_found':
        case 'schedule_conflict':
          return placementProblem(c, outcome);
      }
    },
  );

  router.delete(
    '/:seriesId',
    zValidator('param', SeriesIdParamSchema),
    zValidator('query', DeleteClassSeriesQuerySchema),
    idem,
    async (c) => {
      traceOperation(c, 'classes.series.delete');
      const { seriesId } = readValidated<z.infer<typeof SeriesIdParamSchema>>(c, 'param');
      const { fromClassId } = readValidated<DeleteClassSeriesQuery>(c, 'query');
      const outcome = await deps.deleteSeries(claimsOf(c), seriesId, fromClassId);
      if (outcome.kind === 'not_found') {
        return problem(c, 404, 'not_found', 'class not found in this series');
      }
      return c.json({ deleted: outcome.count }, 200);
    },
  );

  return router;
}

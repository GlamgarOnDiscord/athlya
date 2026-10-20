/**
 * OpenAPI 3.1 spec — CN.9.1.
 *
 * Dedicated `OpenAPIHono` instance whose sole purpose is to serve
 * `GET /openapi.json`. No runtime adapters are wired; route handlers
 * are stubs that are never called (the spec app is mounted before the
 * domain router and `/openapi.json` is a terminal route that short-
 * circuits before reaching any stub).
 *
 * Schemas come directly from `@athlya/shared/schemas/api` so the spec
 * and the runtime handlers share the same Zod definitions — zero drift.
 *
 * Usage in worker.ts:
 *
 *   import { specApp } from './openapi/spec.js';
 *   // Mount BEFORE mountDomainRoutes so /openapi.json resolves first.
 *   app.route('/', specApp);
 */

import {
  BookingRequestSchema,
  BookingResponseSchema,
  CancelReservationParamsSchema,
  CancelReservationResponseSchema,
  ConfirmHoldParamsSchema,
  HoldRequestSchema,
  HoldResponseSchema,
  CardioProgressionQuerySchema,
  CardioProgressionResponseSchema,
  CheckInRequestSchema,
  CheckInResponseSchema,
  CheckInTokenResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  ClassListResponseSchema,
  ClassSeriesDeleteResponseSchema,
  ClassSeriesResponseSchema,
  ClassSeriesUpdateResponseSchema,
  CoachAskRequestSchema,
  CoachAskResponseSchema,
  CoachStatusResponseSchema,
  ClassWithRemainingSchema,
  CreateClassRequestSchema,
  CreateClassSeriesRequestSchema,
  CreateProgramRequestSchema,
  CreateRoomRequestSchema,
  DeleteClassSeriesQuerySchema,
  ExportJobResponseSchema,
  InvoicesPageSchema,
  ListClassesQuerySchema,
  ListInvoicesQuerySchema,
  ListProgramsQuerySchema,
  ListSessionsQuerySchema,
  LogSessionRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  MembersPageResponseSchema,
  ProgramDetailSchema,
  ProgramListResponseSchema,
  ProgramSubscriptionListResponseSchema,
  ProgramSubscriptionSchema,
  ProgressionQuerySchema,
  ProgressionResponseSchema,
  RefreshRequestSchema,
  RoomListResponseSchema,
  RoomSchema,
  ScheduleConflictProblemSchema,
  AuditListResponseSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
  StudioMeResponseSchema,
  SubscribeProgramRequestSchema,
  TodayWorkoutQuerySchema,
  TodayWorkoutResponseSchema,
  UnsubscribeProgramResponseSchema,
  UpdateClassRequestSchema,
  UpdateClassSeriesRequestSchema,
  UpdateConsentsRequestSchema,
  UpdateProfileRequestSchema,
  UpdateProgramRequestSchema,
  UpdateRoomRequestSchema,
  UpdateStudioRequestSchema,
} from '@athlya/shared/schemas/api';
import { UserSchema, WorkoutSessionSchema } from '@athlya/shared/schemas/domain';
import { OpenAPIHono, createRoute, extendZodWithOpenApi } from '@hono/zod-openapi';
import { z } from 'zod';

import type { HonoEnv } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Extend Zod prototype with .openapi()                               */
/* ------------------------------------------------------------------ */

extendZodWithOpenApi(z);

/* ------------------------------------------------------------------ */
/*  Shared response schemas                                            */
/* ------------------------------------------------------------------ */

const ProblemDetailsSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string().optional(),
    traceId: z.string().optional(),
  })
  .openapi({ description: 'RFC 9457 Problem Details error envelope' });

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
});

/**
 * The idempotency middleware answers a malformed key with
 * `application/json` (title `invalid_idempotency_key`), not
 * `application/problem+json`.
 */
const invalidIdempotencyKeyResponse = {
  description:
    'Empty `Idempotency-Key` or longer than 255 characters (title `invalid_idempotency_key`)',
  content: { 'application/json': { schema: ProblemDetailsSchema } },
};

/* ------------------------------------------------------------------ */
/*  Route definitions                                                  */
/* ------------------------------------------------------------------ */

/*
 * auth — /v1/auth/*
 */

const turnstileChallengeRoute = createRoute({
  method: 'get',
  path: '/v1/auth/turnstile-challenge',
  tags: ['auth'],
  summary: 'Turnstile challenge page for the mobile app WebView',
  description:
    'HTML page that renders the Cloudflare Turnstile widget and posts the token to ' +
    '`window.ReactNativeWebView`. The token is then sent as `cf-turnstile-token` to ' +
    '`/v1/auth/login` or `/v1/auth/register`.',
  request: {
    query: z.object({
      lang: z.enum(['fr', 'en']).optional(),
      theme: z.enum(['auto', 'light', 'dark']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Challenge page',
      content: { 'text/html': { schema: z.string() } },
    },
    500: {
      description: 'Turnstile site key not configured',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const deviceAttestationDescription =
  'Requires a `cf-turnstile-token` header. Mobile clients may also send ' +
  '`x-device-attestation-platform` (`android` | `ios`) and `x-device-attestation-token` ' +
  '(Play Integrity token whose `requestHash` is base64url(SHA-256(' +
  '`athlya-auth-v1:<login|register>:<cf-turnstile-token>`)), or Apple DeviceCheck token). ' +
  'The signal is off by default; with `DEVICE_ATTESTATION_MODE=enforce` a presented attestation ' +
  'that fails answers 403 `device_attestation_failed`.';

const registerRoute = createRoute({
  method: 'post',
  path: '/v1/auth/register',
  tags: ['auth'],
  summary: 'Register a new member',
  description: deviceAttestationDescription,
  request: {
    body: {
      content: { 'application/json': { schema: RegisterRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Registration successful — session tokens returned',
      content: { 'application/json': { schema: SessionResponseSchema } },
    },
    409: {
      description: 'Email already registered',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/v1/auth/login',
  tags: ['auth'],
  summary: 'Authenticate with email + password',
  description: deviceAttestationDescription,
  request: {
    body: {
      content: { 'application/json': { schema: LoginRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Login successful',
      content: { 'application/json': { schema: SessionResponseSchema } },
    },
    401: {
      description: 'Invalid credentials',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/v1/auth/refresh',
  tags: ['auth'],
  summary: 'Exchange a refresh token for a new access token',
  request: {
    body: {
      content: { 'application/json': { schema: RefreshRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Token refreshed',
      content: { 'application/json': { schema: SessionResponseSchema } },
    },
    401: {
      description: 'Refresh token invalid or expired',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['auth'],
  summary: 'Revoke the current session',
  description:
    'Revokes the session of the refresh token in the body; the other sessions of the user stay live. ' +
    'Without a refresh token every session of the user is revoked (clients that predate the per-session logout). ' +
    'Use /v1/auth/logout-all to sign out everywhere.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: LogoutRequestSchema } },
      required: false,
    },
  },
  responses: {
    204: { description: 'Session revoked' },
    401: {
      description: 'Not authenticated, or the refresh token is invalid or belongs to another user',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const logoutAllRoute = createRoute({
  method: 'post',
  path: '/v1/auth/logout-all',
  tags: ['auth'],
  summary: 'Revoke all sessions for the current user',
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: 'All sessions revoked' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const passwordResetRequestRoute = createRoute({
  method: 'post',
  path: '/v1/auth/password-reset/request',
  tags: ['auth'],
  summary: 'Send a password-reset email',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ email: z.email() }),
        },
      },
      required: true,
    },
  },
  responses: {
    204: { description: 'Email sent (always, to avoid user enumeration)' },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const passwordResetConfirmRoute = createRoute({
  method: 'post',
  path: '/v1/auth/password-reset/confirm',
  tags: ['auth'],
  summary: 'Complete password reset with a signed token',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ token: z.string().min(1), newPassword: z.string().min(8).max(72) }),
        },
      },
      required: true,
    },
  },
  responses: {
    204: { description: 'Password updated' },
    400: {
      description: 'Token invalid or expired',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const deleteAccountRoute = createRoute({
  method: 'delete',
  path: '/v1/auth/me',
  tags: ['auth'],
  summary: 'Delete the authenticated user account (RGPD Art 17)',
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: 'Account deletion scheduled' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * members — /v1/members/*
 */

const getMeRoute = createRoute({
  method: 'get',
  path: '/v1/members/me',
  tags: ['members'],
  summary: 'Get the current authenticated member profile',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Member profile',
      content: { 'application/json': { schema: UserSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const patchMeRoute = createRoute({
  method: 'patch',
  path: '/v1/members/me',
  tags: ['members'],
  summary: 'Update the current authenticated member profile',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: UpdateProfileRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated member profile',
      content: { 'application/json': { schema: UserSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const patchConsentsRoute = createRoute({
  method: 'patch',
  path: '/v1/members/me/consents',
  tags: ['members'],
  summary: 'Update RGPD consent flags',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: UpdateConsentsRequestSchema } },
      required: true,
    },
  },
  responses: {
    204: { description: 'Consents updated' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const exportMeRoute = createRoute({
  method: 'post',
  path: '/v1/members/me/export',
  tags: ['members'],
  summary: 'Request a personal data export (RGPD Art 15/20)',
  security: [{ bearerAuth: [] }],
  responses: {
    202: {
      description: 'Export job accepted',
      content: { 'application/json': { schema: ExportJobResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limit exceeded (1 per 24h)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const listMembersRoute = createRoute({
  method: 'get',
  path: '/v1/members',
  tags: ['members'],
  summary: 'List studio members (admin / coach only)',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated member list',
      content: { 'application/json': { schema: MembersPageResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * classes — /v1/classes
 */

const listClassesRoute = createRoute({
  method: 'get',
  path: '/v1/classes',
  tags: ['classes'],
  summary: 'List classes in a date range',
  security: [{ bearerAuth: [] }],
  request: { query: ListClassesQuerySchema },
  responses: {
    200: {
      description: 'Class listing with remaining seat counts',
      content: { 'application/json': { schema: ClassListResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Invalid date range',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const createClassRoute = createRoute({
  method: 'post',
  path: '/v1/classes',
  tags: ['classes'],
  summary: 'Create a new class (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: CreateClassRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Class created',
      content: { 'application/json': { schema: ClassWithRemainingSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        '`schedule_conflict`: the room or the coach is taken over an overlapping interval; ' +
        'resend with `allowConflicts: true` to schedule anyway',
      content: { 'application/problem+json': { schema: ScheduleConflictProblemSchema } },
    },
    422: {
      description: 'Validation error, or `room_not_found` for a room outside the studio',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const updateClassRoute = createRoute({
  method: 'patch',
  path: '/v1/classes/{id}',
  tags: ['classes'],
  summary: 'Update a class (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: { 'application/json': { schema: UpdateClassRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Class updated',
      content: { 'application/json': { schema: ClassWithRemainingSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        '`version_conflict` (stale `version`), `capacity_below_confirmed` (capacity under the ' +
        'confirmed reservations and held seats), `class_already_started` (the start time of a ' +
        'class that started cannot change) or `schedule_conflict` (room or coach taken, see ' +
        '`allowConflicts`)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description:
        'Validation error, `starts_at_in_past` for a start time not in the future, or ' +
        '`room_not_found`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const deleteClassRoute = createRoute({
  method: 'delete',
  path: '/v1/classes/{id}',
  tags: ['classes'],
  summary: 'Delete a class (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    204: { description: 'Class deleted' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Class not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * rooms and series: /v1/classes/rooms, /v1/classes/series (issue #748)
 */

const listRoomsRoute = createRoute({
  method: 'get',
  path: '/v1/classes/rooms',
  tags: ['classes'],
  summary: 'List the rooms of the studio',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Live rooms, by name',
      content: { 'application/json': { schema: RoomListResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
  },
});

const createRoomRoute = createRoute({
  method: 'post',
  path: '/v1/classes/rooms',
  tags: ['classes'],
  summary: 'Create a room (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateRoomRequestSchema } }, required: true },
  },
  responses: {
    201: { description: 'Room created', content: { 'application/json': { schema: RoomSchema } } },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    409: problemResponse('`room_name_taken`: a live room of the studio has that name'),
    422: problemResponse('Validation error'),
  },
});

const updateRoomRoute = createRoute({
  method: 'patch',
  path: '/v1/classes/rooms/{roomId}',
  tags: ['classes'],
  summary: 'Rename a room or change its capacity (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ roomId: z.uuid() }),
    body: { content: { 'application/json': { schema: UpdateRoomRequestSchema } }, required: true },
  },
  responses: {
    200: { description: 'Room updated', content: { 'application/json': { schema: RoomSchema } } },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    404: problemResponse('Room not found'),
    409: problemResponse('`room_name_taken`'),
    422: problemResponse('Validation error'),
  },
});

const deleteRoomRoute = createRoute({
  method: 'delete',
  path: '/v1/classes/rooms/{roomId}',
  tags: ['classes'],
  summary: 'Delete a room and unassign it from upcoming classes (admin only)',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ roomId: z.uuid() }) },
  responses: {
    204: { description: 'Room deleted' },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    404: problemResponse('Room not found'),
  },
});

const createSeriesRoute = createRoute({
  method: 'post',
  path: '/v1/classes/series',
  tags: ['classes'],
  summary: 'Create a weekly series of classes (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: CreateClassSeriesRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Every occurrence, sharing one series id',
      content: { 'application/json': { schema: ClassSeriesResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    409: {
      description: '`schedule_conflict`, see `allowConflicts`',
      content: { 'application/problem+json': { schema: ScheduleConflictProblemSchema } },
    },
    422: problemResponse(
      'Validation error, `starts_at_in_past`, `no_occurrences`, `too_many_occurrences` or `room_not_found`',
    ),
  },
});

const updateSeriesRoute = createRoute({
  method: 'patch',
  path: '/v1/classes/series/{seriesId}',
  tags: ['classes'],
  summary: 'Edit an occurrence and every later one (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ seriesId: z.uuid() }),
    body: {
      content: { 'application/json': { schema: UpdateClassSeriesRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The edited occurrences',
      content: { 'application/json': { schema: ClassSeriesUpdateResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    404: problemResponse('Class not found in this series'),
    409: problemResponse(
      '`version_conflict`, `class_already_started`, `capacity_below_confirmed` or `schedule_conflict`',
    ),
    422: problemResponse('Validation error, `starts_at_in_past` or `room_not_found`'),
  },
});

const deleteSeriesRoute = createRoute({
  method: 'delete',
  path: '/v1/classes/series/{seriesId}',
  tags: ['classes'],
  summary: 'Delete an occurrence and every later one (admin only)',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ seriesId: z.uuid() }), query: DeleteClassSeriesQuerySchema },
  responses: {
    200: {
      description: 'Number of occurrences deleted',
      content: { 'application/json': { schema: ClassSeriesDeleteResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Insufficient role'),
    404: problemResponse('Class not found in this series'),
  },
});

/*
 * reservations — /v1/reservations
 */

const bookRoute = createRoute({
  method: 'post',
  path: '/v1/reservations',
  tags: ['reservations'],
  summary: 'Book a class or join the waitlist',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: BookingRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Booking result (confirmed or waitlisted)',
      content: { 'application/json': { schema: BookingResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        'Already booked (body carries the live `status` and, for a waitlist row, its `position`), ' +
        '`class_changed` when the `classVersion` sent is stale, ' +
        'or `idempotency_in_progress` while a request with the same Idempotency-Key runs (`Retry-After`)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description:
        'Validation error, or `idempotency_key_reused` for a key bound to another request',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description:
        '`counter_unavailable` or `idempotency_unavailable`: nothing was written, retry after `Retry-After`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const cancelRoute = createRoute({
  method: 'delete',
  path: '/v1/reservations/{reservationId}',
  tags: ['reservations'],
  summary: 'Cancel a reservation',
  security: [{ bearerAuth: [] }],
  request: {
    params: CancelReservationParamsSchema,
  },
  responses: {
    200: {
      description:
        'Reservation cancelled, or seat hold released. A retried cancel of an already ' +
        'cancelled reservation also answers 200, with `alreadyCancelled: true`',
      content: { 'application/json': { schema: CancelReservationResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Reservation not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        '`idempotency_in_progress` while a request with the same Idempotency-Key runs (`Retry-After`)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description:
        '`cancellation_window_closed`, `invalid_transition`, or `idempotency_key_reused` for a ' +
        'key bound to another request',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description: '`idempotency_unavailable`: nothing was written, retry after `Retry-After`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const holdRoute = createRoute({
  method: 'post',
  path: '/v1/reservations/holds',
  tags: ['reservations'],
  summary: 'Hold a seat for a bounded time before booking it',
  description:
    'Keeps one seat of the class for the member until `expiresAt` (10 minutes). Confirm it with ' +
    '`POST /v1/reservations/{reservationId}/confirm`, release it with ' +
    '`DELETE /v1/reservations/{reservationId}`; an unconfirmed hold expires on its own.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: HoldRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'The member already holds an active hold on this class: that hold',
      content: { 'application/json': { schema: HoldResponseSchema } },
    },
    201: {
      description: 'Seat held',
      content: { 'application/json': { schema: HoldResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Class not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        '`class_full` (no seat to hold; book to join the waitlist), `class_changed` (stale ' +
        '`classVersion`), already booked (body carries the live `status`), or ' +
        '`idempotency_in_progress`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error, `class_in_past`, or `idempotency_key_reused`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description:
        '`counter_unavailable` or `idempotency_unavailable`: nothing was held, retry after `Retry-After`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const confirmHoldRoute = createRoute({
  method: 'post',
  path: '/v1/reservations/{reservationId}/confirm',
  tags: ['reservations'],
  summary: 'Confirm a seat hold into a booking',
  security: [{ bearerAuth: [] }],
  request: {
    params: ConfirmHoldParamsSchema,
  },
  responses: {
    200: {
      description: 'Already confirmed (a retry): the reservation, unchanged',
      content: { 'application/json': { schema: BookingResponseSchema } },
    },
    201: {
      description: 'Hold confirmed',
      content: { 'application/json': { schema: BookingResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Reservation not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    409: {
      description:
        '`hold_expired` (expired or released: hold or book again), `not_a_hold`, or ' +
        '`idempotency_in_progress`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description:
        'Validation error, `class_in_past` (the class started while the seat was held), or ' +
        '`idempotency_key_reused`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description: '`idempotency_unavailable`: nothing was written, retry after `Retry-After`',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const myReservationsRoute = createRoute({
  method: 'get',
  path: '/v1/reservations/me',
  tags: ['reservations'],
  summary: 'List the current user upcoming reservations',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Upcoming reservations',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(z.object({ id: z.uuid(), classId: z.uuid(), status: z.string() })),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * studios — /v1/studios/*
 */

const getStudioMeRoute = createRoute({
  method: 'get',
  path: '/v1/studios/me',
  tags: ['studios'],
  summary: "Get the calling user's studio",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Studio data',
      content: { 'application/json': { schema: StudioMeResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Studio not found',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const patchStudioMeRoute = createRoute({
  method: 'patch',
  path: '/v1/studios/me',
  tags: ['studios'],
  summary: 'Update studio settings (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: UpdateStudioRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated studio',
      content: { 'application/json': { schema: StudioMeResponseSchema } },
    },
    400: {
      description: 'WCAG contrast check failed',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * sessions — /v1/sessions
 */

const logSessionRoute = createRoute({
  method: 'post',
  path: '/v1/sessions',
  tags: ['sessions'],
  summary: 'Log a workout session',
  description:
    'The owner is the JWT subject. `studioId` is optional (solo workouts) and must be the ' +
    "caller's studio when present. Send an `Idempotency-Key` header: a retry with the same key " +
    'replays the stored response instead of logging the session twice. A session imported from ' +
    'another app carries `source` (provider and workout id there): importing the same workout ' +
    'again logs nothing and answers 201 with the session already stored. A session recorded on a ' +
    'cardio machine may carry `cardio`, its structured summary (every metric optional); the ' +
    'response and `GET /v1/sessions/me` return it, and omit the key on sessions without one.',
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({
      'idempotency-key': z
        .string()
        .min(1)
        .max(255)
        .optional()
        .openapi({
          description:
            'Client-generated key (a UUID v4 is recommended). A retry with the same key ' +
            'returns the first response and never logs a second session.',
        }),
    }),
    body: {
      content: { 'application/json': { schema: LogSessionRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Session logged',
      content: { 'application/json': { schema: WorkoutSessionSchema } },
    },
    400: invalidIdempotencyKeyResponse,
    401: problemResponse('Not authenticated'),
    422: problemResponse(
      'Validation error (more than 50 exercises, more than 30 sets per exercise, …) or `studio_mismatch`',
    ),
    429: problemResponse('Rate limited (20 sessions per minute per user)'),
    503: problemResponse('Rate limiter unavailable (fail-closed, code `dependency_unavailable`)'),
  },
});

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/me',
  tags: ['sessions'],
  summary: 'List the current user workout sessions in a date range',
  description:
    'Newest first (`startedAt` descending), at most 100 sessions, window of 90 days at most.',
  security: [{ bearerAuth: [] }],
  request: { query: ListSessionsQuerySchema },
  responses: {
    200: {
      description: 'Session list',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(WorkoutSessionSchema) }),
        },
      },
    },
    401: problemResponse('Not authenticated'),
    422: problemResponse('Invalid date range'),
  },
});

/*
 * me — /v1/me/*
 */

const progressionRoute = createRoute({
  method: 'get',
  path: '/v1/me/progression',
  tags: ['members'],
  summary: 'Per-exercise volume and estimated 1RM trends plus weekly session frequency',
  description:
    'Aggregates the caller workout sessions over the last 30, 90 or 365 UTC days. ' +
    'Volume = reps × weightKg; estimated 1RM uses the Epley formula w × (1 + r/30) ' +
    'on sets of 1–12 reps with a weight. Sends `Cache-Control: private, max-age=60` ' +
    'and an ETag; a matching `If-None-Match` returns 304.',
  security: [{ bearerAuth: [] }],
  request: { query: ProgressionQuerySchema },
  responses: {
    200: {
      description: 'Progression for the requested window',
      content: { 'application/json': { schema: ProgressionResponseSchema } },
    },
    304: { description: 'Not modified (ETag matched)' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Invalid window',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description: 'Rate limiter unavailable (fail-closed, code `dependency_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const cardioProgressionRoute = createRoute({
  method: 'get',
  path: '/v1/me/progression/cardio',
  tags: ['members'],
  summary: 'Per-machine cardio series (moving time, distance, energy, power, heart rate)',
  description:
    'Aggregates the structured `cardio` summary of the caller workout sessions over the ' +
    'last 30, 90 or 365 UTC days, per machine, in zero-filled UTC-day or ISO-week ' +
    '(Monday, UTC) buckets, plus one point per session. Bucket power and heart rate ' +
    'averages are weighted by moving time. Sessions without a `cardio` summary are ' +
    'ignored. Separate from `/v1/me/progression`, whose body is unchanged. Sends ' +
    '`Cache-Control: private, max-age=60` and an ETag; a matching `If-None-Match` returns 304.',
  security: [{ bearerAuth: [] }],
  request: { query: CardioProgressionQuerySchema },
  responses: {
    200: {
      description: 'Cardio progression for the requested window and bucket',
      content: { 'application/json': { schema: CardioProgressionResponseSchema } },
    },
    304: { description: 'Not modified (ETag matched)' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Invalid window or bucket',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    429: {
      description: 'Rate limited',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    503: {
      description: 'Rate limiter unavailable (fail-closed, code `dependency_unavailable`)',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * coach — /v1/coach (Epic 21, behind the `ai-coach` feature flag)
 */

const coachStatusRoute = createRoute({
  method: 'get',
  path: '/v1/coach',
  tags: ['coach'],
  summary: 'AI coach availability, consent and daily quota for the caller',
  description:
    'Returns `{ enabled: false }` when the `ai-coach` feature flag is off for the caller; ' +
    'clients hide the coach then. Otherwise returns the `thirdPartyConsent` opt-in and the ' +
    'daily quota (UTC day). Sends `Cache-Control: no-store`.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Coach status',
      content: { 'application/json': { schema: CoachStatusResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
    429: problemResponse('Rate limited'),
    503: problemResponse('Quota store unavailable (fail-closed, code `dependency_unavailable`)'),
  },
});

const coachAskRoute = createRoute({
  method: 'post',
  path: '/v1/coach/ask',
  tags: ['coach'],
  summary: 'Ask the AI coach a training question',
  description:
    'Sends a minimised summary of the caller workout sessions of the last 30 days (no ' +
    'identifiers, no notes) and the question to the model provider (Mistral), and returns ' +
    'structured advice validated against `CoachAdviceSchema`. Requires the `thirdParty` ' +
    'consent. Limited to 5 requests per minute and a daily quota per member (default 10). ' +
    'With the `ai-coach` flag off it answers 404 before any limiter or body validation. ' +
    'Nothing but the quota counter is stored. Sends `Cache-Control: no-store`. ' +
    'With `Accept: text/event-stream` the answer is streamed as server-sent events once every ' +
    'check above passed (refusals keep their status): `partial` events carry a ' +
    '`CoachAdvicePartial` snapshot (provisional, clipped to the advice bounds, at most one per ' +
    '150 ms), then one ' +
    'terminal `done` event carries the `CoachAskResponse` validated as a whole, or one terminal ' +
    '`error` event carries a problem body (`coach_upstream_failed`, `coach_invalid_output`, ' +
    '`internal_error`) after which the partials are void.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: CoachAskRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Advice and remaining quota (JSON), or the server-sent event stream',
      content: {
        'application/json': { schema: CoachAskResponseSchema },
        'text/event-stream': {
          schema: z.string().openapi({
            description:
              'Server-sent events: `partial` (`CoachAdvicePartial` JSON), then `done` ' +
              '(`CoachAskResponse` JSON) or `error` (problem JSON)',
          }),
        },
      },
    },
    401: problemResponse('Not authenticated'),
    403: problemResponse('Third-party consent missing (code `third_party_consent_required`)'),
    404: problemResponse('Feature flag `ai-coach` off for the caller (code `coach_disabled`)'),
    422: problemResponse('Invalid body'),
    429: problemResponse(
      'Burst limit of 5/min (code `coach_rate_limited`) or daily quota reached (code `coach_quota_exceeded`); see `Retry-After`',
    ),
    502: problemResponse(
      'Model provider failed or answered with invalid output (codes `coach_upstream_failed`, `coach_invalid_output`)',
    ),
    503: problemResponse(
      'Rate limiter or quota store unavailable (fail-closed, code `dependency_unavailable`) or provider not configured (code `coach_not_configured`)',
    ),
  },
});

/*
 * checkins — /v1/checkins
 */

const checkInTokenRoute = createRoute({
  method: 'post',
  path: '/v1/checkins/token',
  tags: ['checkins'],
  summary: 'Issue a QR check-in token for the caller',
  description:
    'Returns a single-use RS256 `QR_Checkin_Token` (`kind = checkin`, 120 s lifetime) that the ' +
    'app renders as a QR code and rotates before `expiresAt`. Never cached (`Cache-Control: no-store`).',
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: 'Token issued',
      content: { 'application/json': { schema: CheckInTokenResponseSchema } },
    },
    401: problemResponse('Not authenticated'),
    429: problemResponse('Rate limited (10 tokens per minute per user)'),
    503: problemResponse('Rate limiter unavailable (fail-closed, code `dependency_unavailable`)'),
  },
});

const checkInRoute = createRoute({
  method: 'post',
  path: '/v1/checkins',
  tags: ['checkins'],
  summary: 'Check a member in from their QR token (kiosk, admin or coach)',
  description:
    "The operator's session must be an admin or coach of the studio; the QR token names the " +
    'member. The token is verified before any reservation or member read and consumed once.',
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({
      'idempotency-key': z.string().min(1).max(255).optional().openapi({
        description: 'Client-generated key; a retry with the same key replays the first response.',
      }),
    }),
    body: {
      content: { 'application/json': { schema: CheckInRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Check-in successful',
      content: { 'application/json': { schema: CheckInResponseSchema } },
    },
    400: invalidIdempotencyKeyResponse,
    401: problemResponse(
      'Not authenticated, or the QR token was rejected (`code`: `invalid_signature`, ' +
        '`token_expired`, `replay`, `wrong_studio`, `wrong_kind`, `malformed`)',
    ),
    403: problemResponse('The caller is not an admin or coach'),
    422: problemResponse(
      'Valid token but no check-in (`code`: `no_reservation`, `outside_window`, `already_checked_in`), or validation error',
    ),
    429: problemResponse(
      'Rate limited (60 check-ins per minute per operator), or `checkin_limit_reached`: the member was already checked in 5 times in the last hour',
    ),
    503: problemResponse('Rate limiter unavailable (fail-closed, code `dependency_unavailable`)'),
  },
});

/*
 * audit — /v1/audit
 */

const listAuditRoute = createRoute({
  method: 'get',
  path: '/v1/audit',
  tags: ['audit'],
  summary: 'List studio audit log entries (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Paginated audit log',
      content: {
        'application/json': {
          schema: AuditListResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * billing — /v1/billing/*
 */

const checkoutRoute = createRoute({
  method: 'post',
  path: '/v1/billing/checkout',
  tags: ['billing'],
  summary: 'Create a Stripe Hosted Checkout session (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: CheckoutRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Checkout session URL',
      content: { 'application/json': { schema: CheckoutResponseSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const listInvoicesRoute = createRoute({
  method: 'get',
  path: '/v1/billing/invoices',
  tags: ['billing'],
  summary: 'List Stripe invoices for the studio (admin only)',
  security: [{ bearerAuth: [] }],
  request: { query: ListInvoicesQuerySchema },
  responses: {
    200: {
      description: 'Paginated invoice list',
      content: { 'application/json': { schema: InvoicesPageSchema } },
    },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    403: {
      description: 'Insufficient role',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

const webhookRoute = createRoute({
  method: 'post',
  path: '/v1/billing/webhook',
  tags: ['billing'],
  summary: 'Stripe webhook receiver (no auth — signature-verified by handler)',
  responses: {
    200: { description: 'Event acknowledged' },
    400: {
      description: 'Invalid Stripe signature',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
  },
});

/*
 * programs — /v1/programs/*
 */

const ProgramIdParamsSchema = z.object({ id: z.uuid() });

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
});

const listProgramsRoute = createRoute({
  method: 'get',
  path: '/v1/programs',
  tags: ['programs'],
  summary: 'List programs (members: published catalogue; staff: every status)',
  security: [{ bearerAuth: [] }],
  request: { query: ListProgramsQuerySchema },
  responses: {
    200: {
      description: 'Programs of the caller studio',
      content: { 'application/json': { schema: ProgramListResponseSchema } },
    },
    401: problem('Not authenticated'),
  },
});

const createProgramRoute = createRoute({
  method: 'post',
  path: '/v1/programs',
  tags: ['programs'],
  summary: 'Create a program with its weeks and workouts (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: CreateProgramRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Created program',
      content: { 'application/json': { schema: ProgramDetailSchema } },
    },
    401: problem('Not authenticated'),
    403: problem('Insufficient role'),
    422: problem('Validation error'),
  },
});

const getProgramRoute = createRoute({
  method: 'get',
  path: '/v1/programs/{id}',
  tags: ['programs'],
  summary: 'Get a program with its schedule',
  security: [{ bearerAuth: [] }],
  request: { params: ProgramIdParamsSchema },
  responses: {
    200: {
      description: 'Program',
      content: { 'application/json': { schema: ProgramDetailSchema } },
    },
    401: problem('Not authenticated'),
    404: problem('Program not found or not visible to the caller'),
  },
});

const updateProgramRoute = createRoute({
  method: 'patch',
  path: '/v1/programs/{id}',
  tags: ['programs'],
  summary: 'Update a program; `weeks` replaces the schedule (admin only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProgramIdParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateProgramRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated program',
      content: { 'application/json': { schema: ProgramDetailSchema } },
    },
    401: problem('Not authenticated'),
    403: problem('Insufficient role'),
    404: problem('Program not found'),
    409: problem('version_conflict or program_archived'),
    422: problem('Validation error'),
  },
});

const archiveProgramRoute = createRoute({
  method: 'post',
  path: '/v1/programs/{id}/archive',
  tags: ['programs'],
  summary: 'Archive a program (admin only, idempotent)',
  security: [{ bearerAuth: [] }],
  request: { params: ProgramIdParamsSchema },
  responses: {
    200: {
      description: 'Archived program',
      content: { 'application/json': { schema: ProgramDetailSchema } },
    },
    401: problem('Not authenticated'),
    403: problem('Insufficient role'),
    404: problem('Program not found'),
  },
});

const subscribeProgramRoute = createRoute({
  method: 'post',
  path: '/v1/programs/{id}/subscription',
  tags: ['programs'],
  summary: 'Subscribe the caller to a published program',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProgramIdParamsSchema,
    body: {
      content: { 'application/json': { schema: SubscribeProgramRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Subscription',
      content: { 'application/json': { schema: ProgramSubscriptionSchema } },
    },
    401: problem('Not authenticated'),
    404: problem('Program not found'),
    409: problem('already_subscribed or program_not_subscribable'),
    422: problem('invalid_start or validation error'),
  },
});

const unsubscribeProgramRoute = createRoute({
  method: 'delete',
  path: '/v1/programs/{id}/subscription',
  tags: ['programs'],
  summary: 'Unsubscribe the caller from a program',
  security: [{ bearerAuth: [] }],
  request: { params: ProgramIdParamsSchema },
  responses: {
    200: {
      description: 'Unsubscribed (replayable with the same Idempotency-Key)',
      content: { 'application/json': { schema: UnsubscribeProgramResponseSchema } },
    },
    401: problem('Not authenticated'),
    404: problem('No active subscription'),
  },
});

const mySubscriptionsRoute = createRoute({
  method: 'get',
  path: '/v1/programs/subscriptions/me',
  tags: ['programs'],
  summary: 'List the caller active program subscriptions',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Active subscriptions',
      content: { 'application/json': { schema: ProgramSubscriptionListResponseSchema } },
    },
    401: problem('Not authenticated'),
  },
});

const todayWorkoutRoute = createRoute({
  method: 'get',
  path: '/v1/programs/today',
  tags: ['programs'],
  summary: "Today's prescribed workout for each active subscription (mobile home)",
  security: [{ bearerAuth: [] }],
  request: { query: TodayWorkoutQuerySchema },
  responses: {
    200: {
      description: 'Daily prescribed workouts',
      content: { 'application/json': { schema: TodayWorkoutResponseSchema } },
    },
    401: problem('Not authenticated'),
    422: problem('invalid_date or validation error'),
  },
});

/* ------------------------------------------------------------------ */
/*  Build spec app                                                     */
/* ------------------------------------------------------------------ */

/**
 * Spec-only `OpenAPIHono` instance. Serves `GET /openapi.json` with
 * an OpenAPI 3.1.0 document derived from the project's Zod schemas.
 *
 * All handlers are stubs — they throw immediately and are never
 * reached because `/openapi.json` short-circuits before delegating to
 * domain handlers.
 */
export function buildSpecApp(): OpenAPIHono<HonoEnv> {
  const app = new OpenAPIHono<HonoEnv>();

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  const stub = (): never => {
    throw new Error('spec-only route — handler must never execute');
  };

  // auth
  app.openapi(turnstileChallengeRoute, stub);
  app.openapi(registerRoute, stub);
  app.openapi(loginRoute, stub);
  app.openapi(refreshRoute, stub);
  app.openapi(logoutRoute, stub);
  app.openapi(logoutAllRoute, stub);
  app.openapi(passwordResetRequestRoute, stub);
  app.openapi(passwordResetConfirmRoute, stub);
  app.openapi(deleteAccountRoute, stub);

  // members
  app.openapi(getMeRoute, stub);
  app.openapi(patchMeRoute, stub);
  app.openapi(patchConsentsRoute, stub);
  app.openapi(exportMeRoute, stub);
  app.openapi(listMembersRoute, stub);

  // classes
  app.openapi(listClassesRoute, stub);
  app.openapi(createClassRoute, stub);
  app.openapi(updateClassRoute, stub);
  app.openapi(deleteClassRoute, stub);
  app.openapi(listRoomsRoute, stub);
  app.openapi(createRoomRoute, stub);
  app.openapi(updateRoomRoute, stub);
  app.openapi(deleteRoomRoute, stub);
  app.openapi(createSeriesRoute, stub);
  app.openapi(updateSeriesRoute, stub);
  app.openapi(deleteSeriesRoute, stub);

  // reservations
  app.openapi(bookRoute, stub);
  app.openapi(cancelRoute, stub);
  app.openapi(holdRoute, stub);
  app.openapi(confirmHoldRoute, stub);
  app.openapi(myReservationsRoute, stub);

  // studios
  app.openapi(getStudioMeRoute, stub);
  app.openapi(patchStudioMeRoute, stub);

  // sessions
  app.openapi(logSessionRoute, stub);
  app.openapi(listSessionsRoute, stub);

  // me
  app.openapi(progressionRoute, stub);
  app.openapi(cardioProgressionRoute, stub);

  // coach
  app.openapi(coachStatusRoute, stub);
  app.openapi(coachAskRoute, stub);

  // audit
  app.openapi(listAuditRoute, stub);

  // checkins
  app.openapi(checkInTokenRoute, stub);
  app.openapi(checkInRoute, stub);

  // billing
  app.openapi(checkoutRoute, stub);
  app.openapi(listInvoicesRoute, stub);
  app.openapi(webhookRoute, stub);

  // programs
  app.openapi(listProgramsRoute, stub);
  app.openapi(createProgramRoute, stub);
  app.openapi(todayWorkoutRoute, stub);
  app.openapi(mySubscriptionsRoute, stub);
  app.openapi(getProgramRoute, stub);
  app.openapi(updateProgramRoute, stub);
  app.openapi(archiveProgramRoute, stub);
  app.openapi(subscribeProgramRoute, stub);
  app.openapi(unsubscribeProgramRoute, stub);

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'Athlya API',
      version: '1.0.0',
      description: 'Multi-tenant gym management API.',
    },
  });

  return app;
}

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
  CheckInRequestSchema,
  CheckInResponseSchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  ClassListResponseSchema,
  ClassWithRemainingSchema,
  CreateClassRequestSchema,
  ExportJobResponseSchema,
  InvoicesPageSchema,
  ListClassesQuerySchema,
  ListInvoicesQuerySchema,
  ListSessionsQuerySchema,
  LogSessionRequestSchema,
  LoginRequestSchema,
  MembersPageResponseSchema,
  RefreshRequestSchema,
  AuditListResponseSchema,
  RegisterRequestSchema,
  SessionResponseSchema,
  StudioMeResponseSchema,
  UpdateClassRequestSchema,
  UpdateConsentsRequestSchema,
  UpdateProfileRequestSchema,
  UpdateStudioRequestSchema,
} from '@athlya/shared/schemas/api';
import { UserSchema } from '@athlya/shared/schemas/domain';
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

/* ------------------------------------------------------------------ */
/*  Route definitions                                                  */
/* ------------------------------------------------------------------ */

/*
 * auth — /v1/auth/*
 */

const registerRoute = createRoute({
  method: 'post',
  path: '/v1/auth/register',
  tags: ['auth'],
  summary: 'Register a new member',
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
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: 'Session revoked' },
    401: {
      description: 'Not authenticated',
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
    422: {
      description: 'Validation error',
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
      description: 'Optimistic lock conflict',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
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
      description: 'Already booked',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'Validation error',
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
    204: { description: 'Reservation cancelled' },
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    404: {
      description: 'Reservation not found',
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
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: LogSessionRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Session logged',
      content: { 'application/json': { schema: z.object({ id: z.uuid() }) } },
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

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/v1/sessions/me',
  tags: ['sessions'],
  summary: 'List the current user workout sessions in a date range',
  security: [{ bearerAuth: [] }],
  request: { query: ListSessionsQuerySchema },
  responses: {
    200: {
      description: 'Session list',
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(z.object({ id: z.uuid() })),
            nextCursor: z.string().nullable(),
          }),
        },
      },
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

/*
 * checkins — /v1/checkins
 */

const checkInRoute = createRoute({
  method: 'post',
  path: '/v1/checkins',
  tags: ['checkins'],
  summary: 'Validate a QR-code check-in',
  security: [{ bearerAuth: [] }],
  request: {
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
    401: {
      description: 'Not authenticated',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
    422: {
      description: 'QR token invalid / already used / class mismatch',
      content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
    },
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

  // reservations
  app.openapi(bookRoute, stub);
  app.openapi(cancelRoute, stub);
  app.openapi(myReservationsRoute, stub);

  // studios
  app.openapi(getStudioMeRoute, stub);
  app.openapi(patchStudioMeRoute, stub);

  // sessions
  app.openapi(logSessionRoute, stub);
  app.openapi(listSessionsRoute, stub);

  // audit
  app.openapi(listAuditRoute, stub);

  // checkins
  app.openapi(checkInRoute, stub);

  // billing
  app.openapi(checkoutRoute, stub);
  app.openapi(listInvoicesRoute, stub);
  app.openapi(webhookRoute, stub);

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

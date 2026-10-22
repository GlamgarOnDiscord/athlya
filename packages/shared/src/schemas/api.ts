/**
 * Zod schemas for every HTTP request / response body accepted or emitted
 * by the Athlya v1 API.
 *
 * Organised into one logical namespace per route prefix (`auth`, `members`,
 * `classes`, `reservations`, `checkins`, `sessions`). Every request schema
 * is `.strict()` to reject unknown fields at the boundary — defense in
 * depth against a newer client quietly sending fields an older server
 * doesn't understand.
 *
 * Inferred types are exported alongside each schema so server-side route
 * handlers and client-side SDK stubs can share the same TypeScript view.
 *
 * Related requirements:
 *   - Requirement 1.1, 1.4, 1.5, 2.1 (auth endpoints).
 *   - Requirement 3.1, 3.2, 3.3, 3.5, 4.1 (member endpoints).
 *   - Requirement 6.1–6.7, 7.1, 7.3 (class endpoints).
 *   - Requirement 8.1, 8.2, 8.5, 9.1, 10.x (reservations / cancellations).
 *   - Requirement 11.1, 11.2, 11.6 (QR check-in).
 *   - Requirement 12.1, 12.2, 12.3, 12.4 (workout sessions).
 *   - Requirement 14.2 (shared Zod validation).
 *   - Requirement 21.1, 21.2 (serialisation round-trip).
 */

import { z } from 'zod';

import { STAFF_ROLES } from '../roles.js';
import { isValidTimeZone, MAX_SERIES_OCCURRENCES } from '../schedule.js';

import { ConsentsSchema } from './consents.js';
import {
  CARDIO_MACHINES,
  CardioMetricsSchema,
  ClassSchema,
  ExerciseSchema,
  ReservationSchema,
  UserSchema,
} from './domain.js';
import {
  ClassIdSchema,
  HexColorSchema,
  IsoDateTimeSchema,
  ReservationIdSchema,
  ReservationStatusSchema,
  RoleSchema,
  SlugSchema,
  StudioIdSchema,
  UserIdSchema,
  UuidSchema,
} from './primitives.js';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Generic cursor-pagination envelope. `nextCursor` is `null` on the last
 * page. Exported as a function so callers can plug in the schema of an
 * individual item.
 */
export const PaginatedResponseSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .strict();

/**
 * Maximum window that class / session browsing endpoints accept, in
 * milliseconds. Requirement 7.3 caps it at 90 days.
 */
const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Shared `(from, to)` date-range refinement: `to > from` and `to - from
 * <= 90 days`. Emits machine-readable `code` values so the API layer can
 * surface `range_inverted` / `range_too_large` Problem Details codes
 * without re-parsing the text.
 */
const refineDateRange = <
  T extends z.ZodObject<{ from: typeof IsoDateTimeSchema; to: typeof IsoDateTimeSchema }>,
>(
  schema: T,
) =>
  schema
    .refine((v) => Date.parse(v.to) > Date.parse(v.from), {
      message: 'to must be strictly after from',
      path: ['to'],
      params: { code: 'range_inverted' },
    })
    .refine((v) => Date.parse(v.to) - Date.parse(v.from) <= MAX_RANGE_MS, {
      message: 'date range must not exceed 90 days',
      path: ['to'],
      params: { code: 'range_too_large' },
    });

/* ------------------------------------------------------------------ */
/*  auth — /v1/auth/*                                                  */
/* ------------------------------------------------------------------ */

/**
 * Input-only variant of ConsentsSchema used at registration / consent
 * update time. The caller sends only the three boolean flags; the server
 * is the sole authority on the CGU `version` currently in effect and the
 * `updatedAt` wall-clock timestamp (Requirement 3.3).
 */
export const ConsentsInputSchema = z
  .object({
    marketing: z.boolean(),
    analytics: z.boolean(),
    thirdParty: z.boolean(),
  })
  .strict();

export type ConsentsInput = z.infer<typeof ConsentsInputSchema>;

/**
 * `POST /v1/auth/register`. The password is bounded at 72 chars — this
 * matches bcrypt's hard 72-byte input limit. bcrypt silently truncates
 * everything past the 72nd byte, so accepting a longer string gives
 * users a false sense of security: characters 73+ add literally zero
 * entropy to the hash. The cap is applied at the wire boundary so no
 * downstream layer has to defend against the truncation footgun.
 * Requirement 1.1 + OWASP Password Storage Cheatsheet.
 */
export const RegisterRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z
      .string()
      .min(8)
      .refine((v) => new TextEncoder().encode(v).length <= 72, {
        message: 'Password must be at most 72 bytes when UTF-8 encoded',
      }),
    displayName: z.string().trim().min(1).max(80),
    studioSlug: SlugSchema,
    consents: ConsentsInputSchema,
  })
  .strict();

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/**
 * `POST /v1/auth/login`. Requirement 1.5. Password capped at 72 bytes
 * to match bcrypt's hard input limit (see `RegisterRequestSchema`).
 */
export const LoginRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z
      .string()
      .min(1)
      .refine((v) => new TextEncoder().encode(v).length <= 72, {
        message: 'Password must be at most 72 bytes when UTF-8 encoded',
      }),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * `POST /v1/auth/oauth/{apple|google}`. Requirement 1.4 — the provider ID
 * token is re-validated against the provider's JWKS server-side before any
 * account linking happens.
 */
export const OAuthLoginRequestSchema = z
  .object({
    provider: z.enum(['apple', 'google']),
    idToken: z.string().min(1),
  })
  .strict();

export type OAuthLoginRequest = z.infer<typeof OAuthLoginRequestSchema>;

/**
 * `POST /v1/auth/refresh`. Requirement 2 / 25.5 (RS256 + kid rotation).
 */
export const RefreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/**
 * Optional body of `POST /v1/auth/logout`. The refresh token names the
 * one session to revoke; without it the gateway falls back to revoking
 * every session of the caller (clients that predate audit finding
 * S2-010).
 */
export const LogoutRequestSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/**
 * Response body returned by `register`, `login`, `oauth/*` and `refresh`.
 * Expiry values are expressed in seconds so clients can schedule their
 * silent-refresh timer without re-parsing JWTs.
 */
export const SessionResponseSchema = z
  .object({
    user: UserSchema,
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessTokenExpiresIn: z.number().int().positive(),
    refreshTokenExpiresIn: z.number().int().positive(),
  })
  .strict();

export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/* ------------------------------------------------------------------ */
/*  members — /v1/members/*                                            */
/* ------------------------------------------------------------------ */

/**
 * `PATCH /v1/members/me`. Only whitelisted fields can be patched
 * (Requirement 3.2) and at least one must be present so we don't waste a
 * round-trip on an empty payload.
 */
export const UpdateProfileRequestSchema = UserSchema.pick({
  displayName: true,
  avatarUrl: true,
})
  .partial()
  .strict()
  .refine((v) => v.displayName !== undefined || v.avatarUrl !== undefined, {
    message: 'must patch at least one of { displayName, avatarUrl }',
  });

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

/**
 * `PUT /v1/members/me/consents`. Requirement 3.3 — server stamps
 * `version` and `updatedAt`; clients only ever submit the boolean flags.
 */
export const UpdateConsentsRequestSchema = ConsentsInputSchema;
export type UpdateConsentsRequest = z.infer<typeof UpdateConsentsRequestSchema>;

/**
 * `POST /v1/members/me/export` → 202 with a job id (Requirement 4.1).
 */
export const ExportJobResponseSchema = z
  .object({
    jobId: UuidSchema,
  })
  .strict();

export type ExportJobResponse = z.infer<typeof ExportJobResponseSchema>;

/**
 * `GET /v1/members` (admin / coach within the same studio — Req 3.5).
 */
export const MembersPageResponseSchema = PaginatedResponseSchema(UserSchema);
export type MembersPageResponse = z.infer<typeof MembersPageResponseSchema>;

/** `GET /v1/members/:id` path parameters. */
export const MemberFileParamsSchema = z
  .object({
    id: UuidSchema,
  })
  .strict();

export type MemberFileParams = z.infer<typeof MemberFileParamsSchema>;

/** Rows of each reservation list of a member file, newest or soonest first. */
export const MEMBER_FILE_LIST_LIMIT = 20;

/** One reservation of a member file, with the class it is for. */
export const MemberFileReservationSchema = z
  .object({
    id: UuidSchema,
    status: ReservationStatusSchema,
    bookedAt: IsoDateTimeSchema,
    cancelledAt: IsoDateTimeSchema.nullable(),
    checkedInAt: IsoDateTimeSchema.nullable(),
    class: z
      .object({
        id: UuidSchema,
        title: z.string(),
        startsAt: IsoDateTimeSchema,
        durationMin: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type MemberFileReservation = z.infer<typeof MemberFileReservationSchema>;

/**
 * `GET /v1/members/:id` (studio admin only): the member's profile and
 * consents, their reservations still to come (confirmed or waitlisted)
 * and the latest past ones, each list capped at
 * {@link MEMBER_FILE_LIST_LIMIT}. `stats` counts every reservation of
 * the member in the studio, not only the rows returned.
 */
export const MemberFileResponseSchema = z
  .object({
    member: z
      .object({
        id: UuidSchema,
        email: z.email(),
        displayName: z.string(),
        avatarUrl: z.url().nullable(),
        role: RoleSchema,
        consents: ConsentsSchema,
        createdAt: IsoDateTimeSchema,
      })
      .strict(),
    upcoming: z.array(MemberFileReservationSchema).max(MEMBER_FILE_LIST_LIMIT),
    past: z.array(MemberFileReservationSchema).max(MEMBER_FILE_LIST_LIMIT),
    stats: z
      .object({
        checkIns: z.number().int().nonnegative(),
        lastCheckInAt: IsoDateTimeSchema.nullable(),
        noShows: z.number().int().nonnegative(),
        cancellations: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type MemberFileResponse = z.infer<typeof MemberFileResponseSchema>;

/* ------------------------------------------------------------------ */
/*  classes — /v1/classes                                              */
/* ------------------------------------------------------------------ */

/**
 * `GET /v1/classes?from=&to=` query parameters. Range refinement mirrors
 * Requirement 7.3 (`range_too_large`) and adds `range_inverted` for
 * malformed intervals.
 */
export const ListClassesQuerySchema = refineDateRange(
  z
    .object({
      from: IsoDateTimeSchema,
      to: IsoDateTimeSchema,
    })
    .strict(),
);

export type ListClassesQuery = z.infer<typeof ListClassesQuerySchema>;

/**
 * `GET /v1/classes/search?q=` query parameters. `q` is trimmed and capped at
 * 200 chars so the tsvector query stays well within PostgreSQL's limits.
 * `from` and `to` narrow the date window; they must be supplied together —
 * providing only one will fail validation.
 *
 * Requirement: CN.8.2.
 */
export const SearchClassesQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
  })
  .strict()
  .refine((v) => (v.from === undefined) === (v.to === undefined), {
    message: 'from and to must both be provided or both omitted',
    path: ['from'],
  });

export type SearchClassesQuery = z.infer<typeof SearchClassesQuerySchema>;

/**
 * One item returned by `GET /v1/classes/search`. Extends `ClassSchema` with
 * `description` (nullable text from migration 0007) and `remaining` (Redis
 * remaining-seats counter, clamped to 0).
 */
export const ClassSearchResultSchema = ClassSchema.extend({
  description: z.string().nullable(),
  remaining: z.number().int().nonnegative(),
});

export type ClassSearchResult = z.infer<typeof ClassSearchResultSchema>;

export const ClassSearchResponseSchema = z
  .object({
    items: z.array(ClassSearchResultSchema),
  })
  .strict();

export type ClassSearchResponse = z.infer<typeof ClassSearchResponseSchema>;

/**
 * `POST /v1/classes`. `coachId` is optional — classes without a coach are
 * legal (e.g. open-gym hours). Requirement 6.1–6.4.
 */
export const CreateClassRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    startsAt: IsoDateTimeSchema,
    durationMin: z.number().int().min(5).max(480),
    capacity: z.number().int().min(1).max(500),
    coachId: UserIdSchema.optional(),
    roomId: UuidSchema.optional(),
    /** Schedule the class even if its room or coach is already taken then (issue #748). */
    allowConflicts: z.boolean().optional(),
  })
  .strict();

export type CreateClassRequest = z.infer<typeof CreateClassRequestSchema>;

/**
 * `PATCH /v1/classes/{id}`. `version` is mandatory for the optimistic-
 * lock check (Requirement 6.6); at least one mutable field must also be
 * present.
 */
export const UpdateClassRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    startsAt: IsoDateTimeSchema.optional(),
    durationMin: z.number().int().min(5).max(480).optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    coachId: UserIdSchema.nullable().optional(),
    roomId: UuidSchema.nullable().optional(),
    version: z.number().int().nonnegative(),
    /** Move the class even if its room or coach is already taken then (issue #748). */
    allowConflicts: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.startsAt !== undefined ||
      v.durationMin !== undefined ||
      v.capacity !== undefined ||
      v.coachId !== undefined ||
      v.roomId !== undefined,
    { message: 'must patch at least one mutable field' },
  );

export type UpdateClassRequest = z.infer<typeof UpdateClassRequestSchema>;

/**
 * `GET /v1/classes` response — each item carries the current `remaining`
 * seat count (Requirement 7.2). `ClassSchema.extend` keeps the base class
 * validation intact and adds the Redis-backed counter on top.
 */
export const ClassWithRemainingSchema = ClassSchema.extend({
  remaining: z.number().int().nonnegative(),
});

export type ClassWithRemaining = z.infer<typeof ClassWithRemainingSchema>;

export const ClassListResponseSchema = z
  .object({
    items: z.array(ClassWithRemainingSchema),
  })
  .strict();

export type ClassListResponse = z.infer<typeof ClassListResponseSchema>;

/** `GET /v1/classes/:id/roster` path parameters. */
export const ClassRosterParamsSchema = z
  .object({
    id: UuidSchema,
  })
  .strict();

export type ClassRosterParams = z.infer<typeof ClassRosterParamsSchema>;

/** `POST /v1/classes/:id/roster/:reservationId/check-in` path parameters. */
export const RosterCheckInParamsSchema = z
  .object({
    id: UuidSchema,
    reservationId: UuidSchema,
  })
  .strict();

export type RosterCheckInParams = z.infer<typeof RosterCheckInParamsSchema>;

/** The person behind a roster row or a class coach: name and avatar, no contact data. */
export const RosterPersonSchema = z
  .object({
    id: UuidSchema,
    displayName: z.string(),
    avatarUrl: z.url().nullable(),
  })
  .strict();

export type RosterPerson = z.infer<typeof RosterPersonSchema>;

/** One reservation on a class roster. */
export const ClassRosterEntrySchema = z
  .object({
    reservationId: UuidSchema,
    status: z.enum(['confirmed', 'waitlist']),
    bookedAt: IsoDateTimeSchema,
    checkedInAt: IsoDateTimeSchema.nullable(),
    member: RosterPersonSchema,
  })
  .strict();

export type ClassRosterEntry = z.infer<typeof ClassRosterEntrySchema>;

/**
 * `GET /v1/classes/:id/roster` (studio admin, or the coach of the class):
 * the confirmed members in booking order, the waitlist in promotion order,
 * and the window in which staff may mark a confirmed member present.
 */
export const ClassRosterResponseSchema = z
  .object({
    class: z
      .object({
        id: UuidSchema,
        title: z.string(),
        startsAt: IsoDateTimeSchema,
        durationMin: z.number().int().positive(),
        capacity: z.number().int().positive(),
        coach: RosterPersonSchema.nullable(),
      })
      .strict(),
    confirmed: z.array(ClassRosterEntrySchema),
    waitlist: z.array(ClassRosterEntrySchema),
    attendance: z
      .object({
        opensAt: IsoDateTimeSchema,
        closesAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type ClassRosterResponse = z.infer<typeof ClassRosterResponseSchema>;

/* ------------------------------------------------------------------ */
/*  rooms and series: /v1/classes/rooms, /v1/classes/series           */
/* ------------------------------------------------------------------ */

const RoomNameSchema = z.string().trim().min(1).max(80);
const RoomCapacitySchema = z.number().int().min(1).max(500);

/** A room of the studio where classes run (issue #748). */
export const RoomSchema = z
  .object({
    id: UuidSchema,
    studioId: StudioIdSchema,
    name: RoomNameSchema,
    capacity: RoomCapacitySchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Room = z.infer<typeof RoomSchema>;

export const RoomListResponseSchema = z.object({ items: z.array(RoomSchema) }).strict();

export type RoomListResponse = z.infer<typeof RoomListResponseSchema>;

/** `POST /v1/classes/rooms`. `capacity` is a default for the classes booked in the room. */
export const CreateRoomRequestSchema = z
  .object({
    name: RoomNameSchema,
    capacity: RoomCapacitySchema.nullable().optional(),
  })
  .strict();

export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

/** `PATCH /v1/classes/rooms/{roomId}`: rename or change the capacity (null clears it). */
export const UpdateRoomRequestSchema = z
  .object({
    name: RoomNameSchema.optional(),
    capacity: RoomCapacitySchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.capacity !== undefined, {
    message: 'must patch at least one mutable field',
  });

export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequestSchema>;

/** An IANA time zone the runtime knows, such as `Europe/Paris`. */
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => isValidTimeZone(value), { message: 'must be an IANA time zone' });

/** A local wall-clock time, `HH:MM` (24 h). */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'must be HH:MM');

/**
 * Weekly repetition: ISO weekdays (1 = Monday ... 7 = Sunday), ended by a
 * last local date (`until`, inclusive) or a number of occurrences
 * (`count`), exactly one of the two.
 */
export const WeeklyRecurrenceSchema = z
  .object({
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, { message: 'weekdays must be unique' }),
    until: z.iso.date().optional(),
    count: z.number().int().min(2).max(MAX_SERIES_OCCURRENCES).optional(),
  })
  .strict()
  .refine((v) => (v.until === undefined) !== (v.count === undefined), {
    message: 'exactly one of until and count is required',
    path: ['until'],
  });

export type WeeklyRecurrence = z.infer<typeof WeeklyRecurrenceSchema>;

/**
 * `POST /v1/classes/series`: the class fields of `POST /v1/classes` plus
 * the repetition. `startsAt` is the first candidate start; every
 * occurrence keeps its wall-clock time in `timeZone`.
 */
export const CreateClassSeriesRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    startsAt: IsoDateTimeSchema,
    durationMin: z.number().int().min(5).max(480),
    capacity: z.number().int().min(1).max(500),
    coachId: UserIdSchema.optional(),
    roomId: UuidSchema.optional(),
    recurrence: WeeklyRecurrenceSchema,
    timeZone: TimeZoneSchema,
    allowConflicts: z.boolean().optional(),
  })
  .strict();

export type CreateClassSeriesRequest = z.infer<typeof CreateClassSeriesRequestSchema>;

export const ClassSeriesResponseSchema = z
  .object({
    seriesId: UuidSchema,
    items: z.array(ClassSchema),
  })
  .strict();

export type ClassSeriesResponse = z.infer<typeof ClassSeriesResponseSchema>;

/**
 * `PATCH /v1/classes/series/{seriesId}`: edit the occurrence
 * `fromClassId` and every later one that has not started. `version` is
 * the anchor's optimistic-lock version. `startTime` (with `timeZone`)
 * moves each occurrence to that wall-clock time on its own day.
 */
export const UpdateClassSeriesRequestSchema = z
  .object({
    fromClassId: ClassIdSchema,
    version: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    durationMin: z.number().int().min(5).max(480).optional(),
    capacity: z.number().int().min(1).max(500).optional(),
    coachId: UserIdSchema.nullable().optional(),
    roomId: UuidSchema.nullable().optional(),
    startTime: LocalTimeSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
    allowConflicts: z.boolean().optional(),
  })
  .strict()
  .refine((v) => (v.startTime === undefined) === (v.timeZone === undefined), {
    message: 'startTime and timeZone go together',
    path: ['timeZone'],
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.durationMin !== undefined ||
      v.capacity !== undefined ||
      v.coachId !== undefined ||
      v.roomId !== undefined ||
      v.startTime !== undefined,
    { message: 'must patch at least one mutable field' },
  );

export type UpdateClassSeriesRequest = z.infer<typeof UpdateClassSeriesRequestSchema>;

/** `DELETE /v1/classes/series/{seriesId}?fromClassId=`: this occurrence and the later ones. */
export const DeleteClassSeriesQuerySchema = z.object({ fromClassId: ClassIdSchema }).strict();

export type DeleteClassSeriesQuery = z.infer<typeof DeleteClassSeriesQuerySchema>;

export const ClassSeriesUpdateResponseSchema = z.object({ items: z.array(ClassSchema) }).strict();

export type ClassSeriesUpdateResponse = z.infer<typeof ClassSeriesUpdateResponseSchema>;

export const ClassSeriesDeleteResponseSchema = z
  .object({ deleted: z.number().int().nonnegative() })
  .strict();

export type ClassSeriesDeleteResponse = z.infer<typeof ClassSeriesDeleteResponseSchema>;

/**
 * One clash reported with a 409 `schedule_conflict`: the start of the
 * class being placed (`occurrenceStartsAt`, one per occurrence of a
 * series) and the existing class it collides with, by room, coach or both.
 */
export const ScheduleConflictSchema = z
  .object({
    occurrenceStartsAt: IsoDateTimeSchema,
    classId: ClassIdSchema,
    title: z.string(),
    startsAt: IsoDateTimeSchema,
    durationMin: z.number().int().positive(),
    reasons: z.array(z.enum(['room', 'coach'])).min(1),
  })
  .strict();

export type ScheduleConflictItem = z.infer<typeof ScheduleConflictSchema>;

/** Most clashes a 409 `schedule_conflict` body lists. */
export const MAX_REPORTED_CONFLICTS = 20;

/** Problem Details body of a 409 `schedule_conflict`. */
export const ScheduleConflictProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.literal(409),
    detail: z.string(),
    code: z.literal('schedule_conflict'),
    traceId: z.string().optional(),
    conflicts: z.array(ScheduleConflictSchema).max(MAX_REPORTED_CONFLICTS),
  })
  .strict();

export type ScheduleConflictProblem = z.infer<typeof ScheduleConflictProblemSchema>;

/* ------------------------------------------------------------------ */
/*  reservations — /v1/reservations                                    */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/reservations`. The `Idempotency-Key` header provides at-most-
 * once semantics (Requirement 8.5, 20.1) and is handled by the API
 * gateway middleware, not by this body schema.
 *
 * `classVersion` is optional (issue #723): the class `version` the
 * member saw. When present the booking is refused with 409
 * `class_changed` if the class was edited since (time, capacity, …),
 * checked under the class row lock. Omitted, the booking behaves as
 * before.
 */
export const BookingRequestSchema = z
  .object({
    classId: ClassIdSchema,
    classVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export type BookingRequest = z.infer<typeof BookingRequestSchema>;

/**
 * Discriminated-union response for the booking endpoint. The tag lives on
 * `status` so clients can `switch` on it without a nested check.
 *
 * Requirement 8.1 (confirmed) / Requirement 8.2 (waitlisted with
 * position).
 */
export const BookingResponseSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('confirmed'),
      reservation: ReservationSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('waitlist'),
      reservation: ReservationSchema,
      position: z.number().int().positive(),
    })
    .strict(),
]);

export type BookingResponse = z.infer<typeof BookingResponseSchema>;

/**
 * Path parameters for `POST /v1/reservations/{reservationId}/cancel`.
 */
export const CancelReservationParamsSchema = z
  .object({
    reservationId: ReservationIdSchema,
  })
  .strict();

export type CancelReservationParams = z.infer<typeof CancelReservationParamsSchema>;

/**
 * Response for a cancel. A retried cancel of a reservation that is
 * already cancelled answers the same shape with `alreadyCancelled: true`.
 */
export const CancelReservationResponseSchema = z
  .object({
    status: z.literal('cancelled'),
    reservation: ReservationSchema,
    alreadyCancelled: z.literal(true).optional(),
  })
  .strict();

export type CancelReservationResponse = z.infer<typeof CancelReservationResponseSchema>;

/**
 * `POST /v1/reservations/holds` (issue #723). Same body as a booking: a
 * hold keeps a seat of `classId` for a bounded time while the client
 * finishes (a checkout, a slow confirmation step), then
 * `POST /v1/reservations/{reservationId}/confirm` turns it into a
 * confirmed reservation. `DELETE /v1/reservations/{reservationId}`
 * releases it; an unconfirmed hold expires on its own.
 */
export const HoldRequestSchema = BookingRequestSchema;

export type HoldRequest = z.infer<typeof HoldRequestSchema>;

/**
 * Response for a hold. `reservationId` is the id to confirm or release;
 * `expiresAt` is when the seat returns to the class if the hold is not
 * confirmed. A hold is never reported as a reservation row: its
 * `pending` status is not part of the wire `ReservationSchema`.
 */
export const HoldResponseSchema = z
  .object({
    status: z.literal('held'),
    hold: z
      .object({
        reservationId: ReservationIdSchema,
        classId: ClassIdSchema,
        expiresAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export type HoldResponse = z.infer<typeof HoldResponseSchema>;

/** Path parameters for `POST /v1/reservations/{reservationId}/confirm`. */
export const ConfirmHoldParamsSchema = CancelReservationParamsSchema;

export type ConfirmHoldParams = z.infer<typeof ConfirmHoldParamsSchema>;

/* ------------------------------------------------------------------ */
/*  checkins — /v1/checkins                                            */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/checkins`. `qrToken` is the opaque JWT produced by the
 * Mobile_App; the server verifies the signature, payload and replay-set
 * before any DB lookup (Requirement 11.2, 11.3, 11.5).
 */
export const CheckInRequestSchema = z
  .object({
    qrToken: z.string().min(1),
  })
  .strict();

export type CheckInRequest = z.infer<typeof CheckInRequestSchema>;

/**
 * `POST /v1/checkins` response. The minimal member info echoed back is
 * what the reception-desk UI needs to greet the member by name without a
 * second round-trip.
 */
export const CheckInResponseSchema = z
  .object({
    success: z.literal(true),
    reservationId: ReservationIdSchema,
    member: z
      .object({
        id: UserIdSchema,
        displayName: z.string(),
        avatarUrl: z.url().nullable(),
      })
      .strict(),
  })
  .strict();

export type CheckInResponse = z.infer<typeof CheckInResponseSchema>;

/**
 * `POST /v1/checkins/token` response. `token` is the `QR_Checkin_Token`
 * (RS256 JWT, `kind = 'checkin'`, single-use `jti`) the Mobile_App
 * renders as a QR code; it expires 120 s after issuance (Requirement
 * 11.1), at `expiresAt`.
 */
export const CheckInTokenResponseSchema = z
  .object({
    token: z.string().min(1),
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export type CheckInTokenResponse = z.infer<typeof CheckInTokenResponseSchema>;

/* ------------------------------------------------------------------ */
/*  sessions — /v1/sessions                                            */
/* ------------------------------------------------------------------ */

/** Apps a workout session can be imported from (task 18.1). */
export const SESSION_SOURCE_PROVIDERS = ['appleHealth'] as const;

export type SessionSourceProvider = (typeof SESSION_SOURCE_PROVIDERS)[number];

/**
 * Where an imported session comes from: the provider and the identifier
 * of the workout there (the HealthKit workout UUID for Apple Health).
 * The API keeps one session per `(user, provider, externalId)`.
 */
export const SessionSourceSchema = z
  .object({
    provider: z.enum(SESSION_SOURCE_PROVIDERS),
    externalId: z.string().trim().min(1).max(128),
  })
  .strict();

export type SessionSource = z.infer<typeof SessionSourceSchema>;

/**
 * `POST /v1/sessions`. `studioId` is optional for solo workouts done
 * outside a partner studio (Requirement 12.1). `cardio` carries the
 * structured summary of a machine session (issue #667); clients that
 * predate it simply omit it. `source` is set on sessions imported from
 * another app.
 */
export const LogSessionRequestSchema = z
  .object({
    startedAt: IsoDateTimeSchema,
    durationMin: z.number().int().positive().optional(),
    exercises: z.array(ExerciseSchema).max(50),
    notes: z.string().max(2000).optional(),
    cardio: CardioMetricsSchema.optional(),
    studioId: StudioIdSchema.optional(),
    source: SessionSourceSchema.optional(),
  })
  .strict();

export type LogSessionRequest = z.infer<typeof LogSessionRequestSchema>;

/**
 * `GET /v1/sessions?from=&to=` query. Same 90-day cap as class browsing.
 */
export const ListSessionsQuerySchema = refineDateRange(
  z
    .object({
      from: IsoDateTimeSchema,
      to: IsoDateTimeSchema,
    })
    .strict(),
);

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

/* ------------------------------------------------------------------ */
/*  progression — /v1/me/progression                                   */
/* ------------------------------------------------------------------ */

/** Window sizes, in days, the progression endpoint accepts (task 22.1). */
export const PROGRESSION_WINDOWS = [30, 90, 365] as const;

export type ProgressionWindow = (typeof PROGRESSION_WINDOWS)[number];

/**
 * `GET /v1/me/progression?window=30|90|365` query. The value arrives as
 * a string; it defaults to 90 days when omitted.
 */
export const ProgressionQuerySchema = z
  .object({
    window: z.enum(['30', '90', '365']).default('90'),
  })
  .strict();

export type ProgressionQuery = z.infer<typeof ProgressionQuerySchema>;

/** `YYYY-MM-DD` UTC calendar day. */
const UtcDaySchema = z.iso.date();

/** One UTC day of one exercise in a progression series. */
export const ProgressionPointSchema = z
  .object({
    date: UtcDaySchema,
    /** Σ reps × weightKg over the day's sets, rounded to 0.1 kg. */
    volumeKg: z.number().nonnegative(),
    /** Best Epley estimate of the day, or `null` when no set qualifies. */
    estimatedOneRepMaxKg: z.number().nonnegative().nullable(),
  })
  .strict();

export type ProgressionPoint = z.infer<typeof ProgressionPointSchema>;

/** Per-exercise progression over the window. */
export const ExerciseProgressionSchema = z
  .object({
    /** Stable grouping key: trimmed, lower-cased, inner whitespace collapsed. */
    key: z.string().min(1).max(120),
    /** Display name, as spelled in the most recent session. */
    name: z.string().min(1).max(120),
    /** Number of sessions in the window containing this exercise. */
    sessionCount: z.number().int().positive(),
    totalVolumeKg: z.number().nonnegative(),
    bestEstimatedOneRepMaxKg: z.number().nonnegative().nullable(),
    /** One point per day the exercise was trained, ascending by date. */
    points: z.array(ProgressionPointSchema),
  })
  .strict();

export type ExerciseProgression = z.infer<typeof ExerciseProgressionSchema>;

/** Sessions started in one ISO week (Monday, UTC). */
export const WeeklyFrequencySchema = z
  .object({
    weekStart: UtcDaySchema,
    sessions: z.number().int().nonnegative(),
  })
  .strict();

export type WeeklyFrequency = z.infer<typeof WeeklyFrequencySchema>;

/**
 * `GET /v1/me/progression` response.
 *
 * The window covers `windowDays` whole UTC days ending with today:
 * `[from, to)` where `to` is the next UTC midnight. `exercises` is sorted
 * by `sessionCount` then `totalVolumeKg`, descending, and capped at 20
 * entries. `weeklyFrequency` is zero-filled and ascending. `truncated` is
 * `true` when the window held more sessions than the server reads, and
 * `skippedSessions` counts stored rows that failed schema validation.
 */
export const ProgressionResponseSchema = z
  .object({
    windowDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    totals: z
      .object({
        sessions: z.number().int().nonnegative(),
        volumeKg: z.number().nonnegative(),
      })
      .strict(),
    exercises: z.array(ExerciseProgressionSchema).max(20),
    weeklyFrequency: z.array(WeeklyFrequencySchema),
    truncated: z.boolean(),
    skippedSessions: z.number().int().nonnegative(),
  })
  .strict();

export type ProgressionResponse = z.infer<typeof ProgressionResponseSchema>;

/* ------------------------------------------------------------------ */
/*  cardio progression — /v1/me/progression/cardio                     */
/* ------------------------------------------------------------------ */

/** Bucket sizes of the cardio series: one UTC day or one ISO week. */
export const CARDIO_PROGRESSION_BUCKETS = ['day', 'week'] as const;

export type CardioProgressionBucket = (typeof CARDIO_PROGRESSION_BUCKETS)[number];

/**
 * Machine key of a cardio series: one of {@link CARDIO_MACHINES}, or
 * `unspecified` for sessions whose summary does not name the machine.
 */
export const CARDIO_PROGRESSION_MACHINES = [...CARDIO_MACHINES, 'unspecified'] as const;

export type CardioProgressionMachine = (typeof CARDIO_PROGRESSION_MACHINES)[number];

/**
 * `GET /v1/me/progression/cardio?window=30|90|365&bucket=day|week`
 * query. `window` defaults to 90 days and `bucket` to `week`.
 */
export const CardioProgressionQuerySchema = z
  .object({
    window: z.enum(['30', '90', '365']).default('90'),
    bucket: z.enum(CARDIO_PROGRESSION_BUCKETS).default('week'),
  })
  .strict();

export type CardioProgressionQuery = z.infer<typeof CardioProgressionQuerySchema>;

/** Summed cardio quantities. A metric a session did not report adds 0. */
export const CardioTotalsSchema = z
  .object({
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().int().nonnegative(),
    energyKcal: z.number().int().nonnegative(),
  })
  .strict();

export type CardioTotals = z.infer<typeof CardioTotalsSchema>;

/**
 * One bucket (UTC day or ISO week starting Monday) of one machine.
 * `avgPowerW` and `avgHeartRateBpm` are the moving-time weighted means
 * of the sessions that reported them (plain mean when none of those
 * sessions reported a duration), rounded to 0.1, or `null` when no
 * session of the bucket reported the metric.
 */
export const CardioSeriesBucketSchema = z
  .object({
    periodStart: UtcDaySchema,
    sessions: z.number().int().nonnegative(),
    durationSec: z.number().int().nonnegative(),
    distanceM: z.number().int().nonnegative(),
    energyKcal: z.number().int().nonnegative(),
    avgPowerW: z.number().nonnegative().nullable(),
    avgHeartRateBpm: z.number().nonnegative().nullable(),
  })
  .strict();

export type CardioSeriesBucket = z.infer<typeof CardioSeriesBucketSchema>;

/** One session of one machine, for per-session trend lines. */
export const CardioSessionPointSchema = z
  .object({
    startedAt: IsoDateTimeSchema,
    durationSec: z.number().int().nonnegative().nullable(),
    distanceM: z.number().int().nonnegative().nullable(),
    avgPowerW: z.number().int().nonnegative().nullable(),
    avgSpeedKmh: z.number().nonnegative().nullable(),
    avgHeartRateBpm: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type CardioSessionPoint = z.infer<typeof CardioSessionPointSchema>;

/** Cardio progression of one machine over the window. */
export const CardioMachineProgressionSchema = z
  .object({
    machine: z.enum(CARDIO_PROGRESSION_MACHINES),
    sessionCount: z.number().int().positive(),
    totals: CardioTotalsSchema,
    /** Zero-filled, ascending, one entry per bucket of the window. */
    series: z.array(CardioSeriesBucketSchema),
    /** One point per session, ascending by `startedAt`. */
    points: z.array(CardioSessionPointSchema),
  })
  .strict();

export type CardioMachineProgression = z.infer<typeof CardioMachineProgressionSchema>;

/**
 * `GET /v1/me/progression/cardio` response, computed from the
 * structured `cardio` summary of the caller's sessions (issue #683).
 *
 * Same window as {@link ProgressionResponseSchema}: `windowDays` whole
 * UTC days ending with today, `[from, to)`. `machines` lists only the
 * machines with at least one session, in {@link CARDIO_PROGRESSION_MACHINES}
 * order. Sessions without a `cardio` summary are not counted; rows whose
 * summary fails validation are counted in `skippedSessions`. This is a
 * separate contract so `GET /v1/me/progression` stays unchanged for
 * installed clients that parse it strictly.
 */
export const CardioProgressionResponseSchema = z
  .object({
    windowDays: z.union([z.literal(30), z.literal(90), z.literal(365)]),
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    bucket: z.enum(CARDIO_PROGRESSION_BUCKETS),
    totals: CardioTotalsSchema.extend({
      sessions: z.number().int().nonnegative(),
    }).strict(),
    machines: z.array(CardioMachineProgressionSchema).max(CARDIO_PROGRESSION_MACHINES.length),
    truncated: z.boolean(),
    skippedSessions: z.number().int().nonnegative(),
  })
  .strict();

export type CardioProgressionResponse = z.infer<typeof CardioProgressionResponseSchema>;

/* ------------------------------------------------------------------ */
/*  coach — /v1/coach                                                  */
/* ------------------------------------------------------------------ */

/** Longest question a member may ask the AI coach, in characters. */
export const COACH_QUESTION_MAX_LENGTH = 500;

/** Languages the AI coach answers in. */
export const COACH_LOCALES = ['fr', 'en'] as const;

export type CoachLocale = (typeof COACH_LOCALES)[number];

/** `POST /v1/coach/ask` body (task 21.2). */
export const CoachAskRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(COACH_QUESTION_MAX_LENGTH),
    locale: z.enum(COACH_LOCALES).default('fr'),
  })
  .strict();

export type CoachAskRequest = z.infer<typeof CoachAskRequestSchema>;

/** One actionable recommendation of the AI coach. */
export const CoachRecommendationSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(400),
  })
  .strict();

export type CoachRecommendation = z.infer<typeof CoachRecommendationSchema>;

/**
 * Structured advice produced by the language model (task 21.1). The
 * model output is parsed with this schema before it reaches the client;
 * anything that does not match is discarded server-side.
 */
export const CoachAdviceSchema = z
  .object({
    summary: z.string().trim().min(1).max(600),
    recommendations: z.array(CoachRecommendationSchema).min(1).max(5),
    /** Safety note (pain, injury, medical topic), or `null`. */
    caution: z.string().trim().min(1).max(300).nullable(),
  })
  .strict();

export type CoachAdvice = z.infer<typeof CoachAdviceSchema>;

/** Daily AI coach quota of the caller (UTC calendar day). */
export const CoachQuotaSchema = z
  .object({
    limit: z.number().int().positive(),
    remaining: z.number().int().nonnegative(),
    /** Next UTC midnight, when the counter resets. */
    resetsAt: IsoDateTimeSchema,
  })
  .strict()
  .refine((quota) => quota.remaining <= quota.limit, {
    message: 'remaining must not exceed limit',
    path: ['remaining'],
  });

export type CoachQuota = z.infer<typeof CoachQuotaSchema>;

/**
 * `GET /v1/coach` response. `enabled: false` when the `ai-coach`
 * feature flag is off for the caller; clients hide the coach then.
 * `thirdPartyConsent` is the member's opt-in to send their training
 * data to the model provider.
 */
export const CoachStatusResponseSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      thirdPartyConsent: z.boolean(),
      quota: CoachQuotaSchema,
    })
    .strict(),
]);

export type CoachStatusResponse = z.infer<typeof CoachStatusResponseSchema>;

/** `POST /v1/coach/ask` response. */
export const CoachAskResponseSchema = z
  .object({
    advice: CoachAdviceSchema,
    quota: CoachQuotaSchema,
    generatedAt: IsoDateTimeSchema,
  })
  .strict();

export type CoachAskResponse = z.infer<typeof CoachAskResponseSchema>;

/**
 * Advice built so far, sent as a `partial` event when `POST /v1/coach/ask`
 * streams (`Accept: text/event-stream`). Each event is a full snapshot,
 * not a delta. It is provisional: the fields are clipped to the bounds of
 * {@link CoachAdviceSchema}, but only the `done` event carries advice
 * validated as a whole.
 */
export const CoachAdvicePartialSchema = z
  .object({
    summary: z.string().max(600).optional(),
    recommendations: z
      .array(
        z
          .object({
            title: z.string().max(80).optional(),
            detail: z.string().max(400).optional(),
          })
          .strict(),
      )
      .max(5)
      .optional(),
    caution: z.string().max(300).nullable().optional(),
  })
  .strict();

export type CoachAdvicePartial = z.infer<typeof CoachAdvicePartialSchema>;

/**
 * Server-sent event names of the streamed `POST /v1/coach/ask`:
 *
 *   - `partial` — {@link CoachAdvicePartialSchema} snapshot, zero or more.
 *   - `done`    — {@link CoachAskResponseSchema}, terminal.
 *   - `error`   — RFC 7807 problem body, terminal; partials are void.
 */
export const COACH_STREAM_EVENTS = ['partial', 'done', 'error'] as const;

export type CoachStreamEvent = (typeof COACH_STREAM_EVENTS)[number];

/* ------------------------------------------------------------------ */
/*  studios — /v1/studios/*                                            */
/* ------------------------------------------------------------------ */

/**
 * A studio logo as the API stores it: an https URL (R2 public object) or,
 * when no bucket is configured, a `data:image/(png|jpeg|webp);base64,` URL
 * capped by migration 0053. `null` when the studio has none.
 */
export const StudioLogoSchema = z
  .string()
  .max(180_000)
  .regex(/^(https:\/\/\S+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2})$/u)
  .nullable();

/**
 * `GET /v1/studios/me` response: slice B9.1, white label (issue #761).
 *
 * Returns the caller's tenant root row (resolved from `claims.studioId`)
 * with the columns the front-end needs to drive its theming and admin
 * surfaces:
 *
 *   • `id`, `slug`, `name`: identity and addressing fields.
 *   • `brandColor`: `#RRGGBB` hex fed straight into
 *     `buildBrandColorCss(...)` from `@athlya/shared/theming`.
 *   • `brandLogoLight` / `brandLogoDark`: logo for light and dark
 *     surfaces, see {@link StudioLogoSchema}.
 *   • `hideAthlyaBranding`: drops the "via Athlya" mention of the
 *     studio's transactional e-mails.
 */
export const StudioMeResponseSchema = z
  .object({
    id: UuidSchema,
    slug: SlugSchema,
    name: z.string().min(1).max(120),
    brandColor: HexColorSchema,
    brandLogoLight: StudioLogoSchema,
    brandLogoDark: StudioLogoSchema,
    hideAthlyaBranding: z.boolean(),
  })
  .strict();

export type StudioMeResponse = z.infer<typeof StudioMeResponseSchema>;

/**
 * `PATCH /v1/studios/me` (admin only): slice B9.2, issue #761.
 *
 * Whitelists the editable scalar fields. At least one must be present so
 * the server does not waste a round-trip on an empty patch. The strict
 * shape ensures no surprise column (e.g. `slug`, `id`) can be patched
 * via this endpoint. Logos have their own binary upload route
 * (`PUT /v1/studios/me/logo/{light|dark}`).
 *
 * `brandColor` MUST additionally pass a WCAG 2.2 AA contrast check
 * server-side against the text color the theming helper pairs with it
 * before the row is updated. That check lives in the route handler:
 * Zod can only enforce the regex shape, not the perceptual contrast.
 */
export const UpdateStudioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    brandColor: HexColorSchema.optional(),
    hideAthlyaBranding: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.brandColor !== undefined || v.hideAthlyaBranding !== undefined,
    { message: 'must patch at least one of { name, brandColor, hideAthlyaBranding }' },
  );

export type UpdateStudioRequest = z.infer<typeof UpdateStudioRequestSchema>;

/** Logo variants of `PUT|DELETE /v1/studios/me/logo/{variant}`. */
export const StudioLogoVariantSchema = z.enum(['light', 'dark']);

export type StudioLogoVariant = z.infer<typeof StudioLogoVariantSchema>;

/**
 * Kinds of custom domain a studio registers (issue #761): `web` serves
 * the member app on the studio's own hostname, `email` sends the
 * studio's transactional e-mails from its own domain.
 */
export const StudioDomainKindSchema = z.enum(['web', 'email']);

export type StudioDomainKind = z.infer<typeof StudioDomainKindSchema>;

/**
 * A DNS hostname as typed by an admin: trimmed, lower-cased, no scheme,
 * no trailing dot, at least two labels, and outside Athlya's own zone.
 * Mirrors the `studio_domains_hostname_check` constraint of migration
 * 0053.
 */
export const StudioHostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/u,
    'must be a hostname such as club.example.com',
  )
  .refine((host) => host !== 'athlya.app' && !host.endsWith('.athlya.app'), {
    message: 'must not be an athlya.app hostname',
  });

/** `PUT /v1/studios/me/domains/{kind}` body. */
export const SetStudioDomainRequestSchema = z.object({ hostname: StudioHostnameSchema }).strict();

export type SetStudioDomainRequest = z.infer<typeof SetStudioDomainRequestSchema>;

/**
 * Outcome of the last lookup of one expected record:
 *   • `ok`: found with the expected value;
 *   • `missing`: no record of that type at that name;
 *   • `mismatch`: a record exists with another value;
 *   • `unchecked`: never looked up yet;
 *   • `awaiting_value`: the value is issued during provisioning (DKIM)
 *     and the operator has not entered it yet.
 */
export const DnsRecordCheckSchema = z.enum([
  'ok',
  'missing',
  'mismatch',
  'unchecked',
  'awaiting_value',
]);

export type DnsRecordCheck = z.infer<typeof DnsRecordCheckSchema>;

/** One DNS record the studio has to publish, with its last check. */
export const DnsRecordSchema = z
  .object({
    purpose: z.enum(['ownership', 'routing', 'spf', 'return_path', 'dkim', 'dmarc']),
    type: z.enum(['CNAME', 'TXT', 'MX']),
    name: z.string().min(1).max(253),
    value: z.string().max(2048).nullable(),
    priority: z.number().int().min(0).max(65535).nullable(),
    required: z.boolean(),
    check: DnsRecordCheckSchema,
  })
  .strict();

export type DnsRecord = z.infer<typeof DnsRecordSchema>;

/**
 * A registered custom domain. `status` is the DNS verdict (`verified`
 * once every required record was found); `activatedAt` is set by an
 * operator once Cloudflare or Resend serves the domain
 * (`docs/runbooks/white-label-domains.md`).
 */
export const StudioDomainSchema = z
  .object({
    kind: StudioDomainKindSchema,
    hostname: z.string().min(1).max(253),
    status: z.enum(['pending', 'verified', 'failed']),
    records: z.array(DnsRecordSchema),
    lastCheckedAt: IsoDateTimeSchema.nullable(),
    verifiedAt: IsoDateTimeSchema.nullable(),
    activatedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export type StudioDomain = z.infer<typeof StudioDomainSchema>;

/** `GET /v1/studios/me/domains` response. */
export const StudioDomainsResponseSchema = z
  .object({ items: z.array(StudioDomainSchema).max(2) })
  .strict();

export type StudioDomainsResponse = z.infer<typeof StudioDomainsResponseSchema>;

/* ------------------------------------------------------------------ */
/*  billing — /v1/billing/*                                            */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/billing/checkout` — slice B9.3.
 *
 * Body validates the requested subscription tier. The free plan is the
 * default for every studio so it does not have a checkout flow — only
 * `pro` (and any future paid tier) reaches Stripe.
 */
export const CheckoutRequestSchema = z
  .object({
    plan: z.enum(['pro']),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

/**
 * Response body emitted by `POST /v1/billing/checkout` — clients
 * forward the user to `checkoutUrl` for Stripe Hosted Checkout.
 */
export const CheckoutResponseSchema = z
  .object({
    checkoutUrl: z.url(),
  })
  .strict();

export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

/**
 * `GET /v1/billing/invoices?cursor=&limit=` — slice B9.4.
 *
 * Cursor-paginated listing of Stripe invoices for the calling studio.
 * Until Stripe is provisioned in production, the handler returns an
 * empty page so the studio dashboard renders a stable "no invoices yet"
 * empty state instead of a 503 (mode dégradé documenté dans le runbook
 * `docs/runbooks/billing.md`).
 */
export const ListInvoicesQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuerySchema>;

/** Single invoice projection. Mirrors the subset Stripe returns. */
export const InvoiceItemSchema = z
  .object({
    id: z.string().min(1),
    number: z.string().nullable(),
    status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']),
    amountDue: z.number().int().nonnegative(),
    currency: z.string().length(3),
    createdAt: IsoDateTimeSchema,
    hostedInvoiceUrl: z.url().nullable(),
  })
  .strict();

export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

/** `GET /v1/billing/invoices` response shape. */
export const InvoicesPageSchema = z
  .object({
    items: z.array(InvoiceItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type InvoicesPage = z.infer<typeof InvoicesPageSchema>;

/* ------------------------------------------------------------------ */
/*  audit — /v1/audit                                                   */
/* ------------------------------------------------------------------ */

/**
 * Single item returned by `GET /v1/audit` — task 12.5.
 *
 * `metadata` is omitted from the list response to cap payload size.
 * The `id` is a BIGSERIAL serialised as a string (Req 21.1 — lossless
 * above Number.MAX_SAFE_INTEGER).
 */
export const AuditListItemSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.uuid().nullable(),
    action: z.string().min(1).max(120),
    targetType: z.string().max(60).nullable(),
    targetId: z.string().max(80).nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type AuditListItem = z.infer<typeof AuditListItemSchema>;

/** `GET /v1/audit` response — cursor-paginated, newest first. */
export const AuditListResponseSchema = z
  .object({
    items: z.array(AuditListItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

/* ------------------------------------------------------------------ */
/*  programs — /v1/programs                                            */
/* ------------------------------------------------------------------ */

/**
 * Training programs (Epic 24). A program is a list of weeks; each week
 * prescribes at most one workout per day (`dayNumber` 1..7, day 1 being
 * the first day of the week counted from the member's start date).
 * Days without a workout are rest days.
 *
 * The bounds keep the largest program well under the gateway's 256 KiB
 * body limit; the database enforces looser ceilings (52 weeks,
 * 30 exercises) as defence in depth.
 */
export const MAX_PROGRAM_WEEKS = 16;
export const MAX_PROGRAM_EXERCISES = 15;

/**
 * The per-field bounds alone allow a schedule far larger than the
 * gateway's 256 KiB `/v1` body cap (16 weeks × 7 days × 15 exercises).
 * The whole schedule is therefore also capped by its serialised UTF-8
 * size, with headroom for the other fields, so every program the schema
 * accepts also fits through the gateway.
 */
export const MAX_PROGRAM_SCHEDULE_BYTES = 200 * 1024;

const utf8Length = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Calendar date without a time zone, `YYYY-MM-DD`. */
export const LocalDateSchema = z.iso.date();

export const ProgramStatusSchema = z.enum(['draft', 'published', 'archived']);
export type ProgramStatus = z.infer<typeof ProgramStatusSchema>;

/** Status an admin may set directly; archiving has its own endpoint. */
export const EditableProgramStatusSchema = z.enum(['draft', 'published']);

export const ProgramExerciseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sets: z.number().int().min(1).max(20),
    reps: z.number().int().min(1).max(200).optional(),
    durationSec: z.number().int().min(1).max(3600).optional(),
    weightKg: z.number().min(0).max(1000).optional(),
    restSec: z.number().int().min(0).max(900).optional(),
    notes: z.string().trim().max(280).optional(),
  })
  .strict();

export type ProgramExercise = z.infer<typeof ProgramExerciseSchema>;

export const ProgramWorkoutInputSchema = z
  .object({
    dayNumber: z.number().int().min(1).max(7),
    title: z.string().trim().min(1).max(120),
    notes: z.string().trim().max(2000).optional(),
    exercises: z.array(ProgramExerciseSchema).max(MAX_PROGRAM_EXERCISES),
  })
  .strict();

export type ProgramWorkoutInput = z.infer<typeof ProgramWorkoutInputSchema>;

export const ProgramWeekInputSchema = z
  .object({
    weekNumber: z.number().int().min(1).max(MAX_PROGRAM_WEEKS),
    title: z.string().trim().max(120).optional(),
    workouts: z.array(ProgramWorkoutInputSchema).max(7),
  })
  .strict()
  .refine((w) => new Set(w.workouts.map((d) => d.dayNumber)).size === w.workouts.length, {
    message: 'each day of a week holds at most one workout',
    path: ['workouts'],
    params: { code: 'duplicate_day' },
  });

export type ProgramWeekInput = z.infer<typeof ProgramWeekInputSchema>;

/**
 * Weeks must be numbered 1..n without gaps or duplicates, so the
 * program length is simply `weeks.length`.
 */
const ProgramWeeksSchema = z
  .array(ProgramWeekInputSchema)
  .min(1)
  .max(MAX_PROGRAM_WEEKS)
  .refine(
    (weeks) =>
      weeks
        .map((w) => w.weekNumber)
        .sort((a, b) => a - b)
        .every((n, i) => n === i + 1),
    { message: 'weeks must be numbered 1..n without gaps', params: { code: 'week_sequence' } },
  )
  .refine((weeks) => utf8Length(weeks) <= MAX_PROGRAM_SCHEDULE_BYTES, {
    message: `the schedule must not exceed ${String(MAX_PROGRAM_SCHEDULE_BYTES / 1024)} KiB`,
    params: { code: 'schedule_too_large' },
  });

/** `POST /v1/programs` (admin). New programs start as drafts by default. */
export const CreateProgramRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    status: EditableProgramStatusSchema.optional(),
    weeks: ProgramWeeksSchema,
  })
  .strict();

export type CreateProgramRequest = z.infer<typeof CreateProgramRequestSchema>;

/**
 * `PATCH /v1/programs/{id}` (admin). `version` is the optimistic-lock
 * guard; `weeks`, when present, replaces the whole schedule.
 */
export const UpdateProgramRequestSchema = z
  .object({
    version: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: EditableProgramStatusSchema.optional(),
    weeks: ProgramWeeksSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.weeks !== undefined,
    { message: 'must patch at least one of { title, description, status, weeks }' },
  );

export type UpdateProgramRequest = z.infer<typeof UpdateProgramRequestSchema>;

export const ListProgramsQuerySchema = z
  .object({
    status: ProgramStatusSchema.optional(),
  })
  .strict();

export type ListProgramsQuery = z.infer<typeof ListProgramsQuerySchema>;

export const ProgramWorkoutSchema = z
  .object({
    id: UuidSchema,
    dayNumber: z.number().int().min(1).max(7),
    title: z.string(),
    notes: z.string().nullable(),
    exercises: z.array(ProgramExerciseSchema),
  })
  .strict();

export type ProgramWorkout = z.infer<typeof ProgramWorkoutSchema>;

export const ProgramWeekSchema = z
  .object({
    weekNumber: z.number().int().min(1),
    title: z.string().nullable(),
    workouts: z.array(ProgramWorkoutSchema),
  })
  .strict();

export type ProgramWeek = z.infer<typeof ProgramWeekSchema>;

export const ProgramSummarySchema = z
  .object({
    id: UuidSchema,
    studioId: UuidSchema,
    title: z.string(),
    description: z.string().nullable(),
    status: ProgramStatusSchema,
    version: z.number().int().nonnegative(),
    weekCount: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export type ProgramSummary = z.infer<typeof ProgramSummarySchema>;

/** `GET /v1/programs/{id}` and every program mutation response. */
export const ProgramDetailSchema = ProgramSummarySchema.extend({
  weeks: z.array(ProgramWeekSchema),
}).strict();

export type ProgramDetail = z.infer<typeof ProgramDetailSchema>;

export const ProgramListResponseSchema = z
  .object({
    items: z.array(ProgramSummarySchema),
  })
  .strict();

export type ProgramListResponse = z.infer<typeof ProgramListResponseSchema>;

/**
 * `POST /v1/programs/{id}/subscription`. `startsOn` is the member's
 * local date of day 1; it defaults to the server's UTC date.
 */
export const SubscribeProgramRequestSchema = z
  .object({
    startsOn: LocalDateSchema.optional(),
  })
  .strict();

export type SubscribeProgramRequest = z.infer<typeof SubscribeProgramRequestSchema>;

export const ProgramSubscriptionSchema = z
  .object({
    id: UuidSchema,
    programId: UuidSchema,
    programTitle: z.string(),
    programStatus: ProgramStatusSchema,
    startsOn: LocalDateSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type ProgramSubscription = z.infer<typeof ProgramSubscriptionSchema>;

export const ProgramSubscriptionListResponseSchema = z
  .object({
    items: z.array(ProgramSubscriptionSchema),
  })
  .strict();

export type ProgramSubscriptionListResponse = z.infer<typeof ProgramSubscriptionListResponseSchema>;

/**
 * `DELETE /v1/programs/{id}/subscription` — a JSON body rather than 204
 * so an idempotent retry replays the success.
 */
export const UnsubscribeProgramResponseSchema = z
  .object({
    programId: UuidSchema,
    unsubscribed: z.literal(true),
  })
  .strict();

export type UnsubscribeProgramResponse = z.infer<typeof UnsubscribeProgramResponseSchema>;

/**
 * `GET /v1/programs/today?date=YYYY-MM-DD` — the mobile home "today's
 * prescribed workout" contract. `date` is the member's local date and
 * defaults to the server's UTC date.
 */
export const TodayWorkoutQuerySchema = z
  .object({
    date: LocalDateSchema.optional(),
  })
  .strict();

export type TodayWorkoutQuery = z.infer<typeof TodayWorkoutQuerySchema>;

/**
 * Where `date` falls in a subscription:
 *   - `scheduled`   — a workout is prescribed (`workout` is set);
 *   - `rest`        — inside the program, no workout that day;
 *   - `not_started` — before `startsOn`;
 *   - `completed`   — after the last week.
 */
export const TodayWorkoutStatusSchema = z.enum(['scheduled', 'rest', 'not_started', 'completed']);

export type TodayWorkoutStatus = z.infer<typeof TodayWorkoutStatusSchema>;

export const TodayWorkoutItemSchema = z
  .object({
    subscriptionId: UuidSchema,
    program: z.object({ id: UuidSchema, title: z.string() }).strict(),
    startsOn: LocalDateSchema,
    totalWeeks: z.number().int().nonnegative(),
    status: TodayWorkoutStatusSchema,
    weekNumber: z.number().int().min(1).nullable(),
    dayNumber: z.number().int().min(1).max(7).nullable(),
    workout: ProgramWorkoutSchema.nullable(),
  })
  .strict();

export type TodayWorkoutItem = z.infer<typeof TodayWorkoutItemSchema>;

export const TodayWorkoutResponseSchema = z
  .object({
    date: LocalDateSchema,
    items: z.array(TodayWorkoutItemSchema),
  })
  .strict();

export type TodayWorkoutResponse = z.infer<typeof TodayWorkoutResponseSchema>;

/* ------------------------------------------------------------------ */
/*  team: /v1/studios/me/team/* (issue #756)                          */
/* ------------------------------------------------------------------ */

/** A role an admin may grant from the Team page. */
export const StaffRoleSchema = z.enum(STAFF_ROLES);

export type StaffRoleValue = z.infer<typeof StaffRoleSchema>;

/** One account of the studio team. */
export const TeamMemberSchema = z
  .object({
    id: UserIdSchema,
    displayName: z.string(),
    email: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    role: StaffRoleSchema,
    joinedAt: IsoDateTimeSchema,
  })
  .strict();

export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** A pending invitation (never the token). */
export const TeamInvitationSchema = z
  .object({
    id: UuidSchema,
    email: z.string(),
    role: StaffRoleSchema,
    invitedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export type TeamInvitation = z.infer<typeof TeamInvitationSchema>;

/** `GET /v1/team`: the team, the caller first, then by name. */
export const TeamResponseSchema = z
  .object({
    members: z.array(TeamMemberSchema),
    invitations: z.array(TeamInvitationSchema),
  })
  .strict();

export type TeamResponse = z.infer<typeof TeamResponseSchema>;

/** `POST /v1/team/invitations` (admin). */
export const InviteTeamMemberRequestSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    role: StaffRoleSchema,
  })
  .strict();

export type InviteTeamMemberRequest = z.infer<typeof InviteTeamMemberRequestSchema>;

/**
 * Answer to an invitation. An account of the studio with that email gets
 * the role at once (`role_updated`); otherwise a pending invitation is
 * created and its token is returned this once, for the admin to share.
 */
export const InviteTeamMemberResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('role_updated'), member: TeamMemberSchema }).strict(),
  z
    .object({
      outcome: z.literal('invited'),
      invitation: TeamInvitationSchema,
      token: z.string(),
    })
    .strict(),
]);

export type InviteTeamMemberResponse = z.infer<typeof InviteTeamMemberResponseSchema>;

/** `PATCH /v1/team/members/:id` (admin): `member` takes the account off the team. */
export const UpdateTeamMemberRequestSchema = z
  .object({ role: z.enum(['member', ...STAFF_ROLES]) })
  .strict();

export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberRequestSchema>;

export const TeamMemberParamsSchema = z.object({ id: UserIdSchema }).strict();

export type TeamMemberParams = z.infer<typeof TeamMemberParamsSchema>;

export const TeamInvitationParamsSchema = z.object({ id: UuidSchema }).strict();

export type TeamInvitationParams = z.infer<typeof TeamInvitationParamsSchema>;

/** Invitation token: 32 random bytes, base64url without padding. */
export const InvitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/** `POST /v1/team/invitations/accept`, by the invited account. */
export const AcceptInvitationRequestSchema = z.object({ token: InvitationTokenSchema }).strict();

export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export const AcceptInvitationResponseSchema = z.object({ role: StaffRoleSchema }).strict();

export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

/* ------------------------------------------------------------------ */
/*  auth sessions: /v1/auth/sessions (issue #757)                     */
/* ------------------------------------------------------------------ */

export const SessionDeviceSchema = z
  .object({
    browser: z.enum(['chrome', 'edge', 'firefox', 'safari', 'app', 'other']),
    os: z.enum(['ios', 'android', 'macos', 'windows', 'linux', 'other']),
  })
  .strict();

export type SessionDeviceValue = z.infer<typeof SessionDeviceSchema>;

/** Public handle of a session: 32 lowercase hex digits. */
export const SessionHandleSchema = z.string().regex(/^[0-9a-f]{32}$/u);

/**
 * One active session. The times are `null` for a session signed in
 * before they were recorded; `current` marks the caller's own session.
 */
export const ActiveSessionSchema = z
  .object({
    id: SessionHandleSchema,
    device: SessionDeviceSchema.nullable(),
    createdAt: IsoDateTimeSchema.nullable(),
    lastSeenAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema,
    current: z.boolean(),
  })
  .strict();

export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

export const ActiveSessionsResponseSchema = z
  .object({ items: z.array(ActiveSessionSchema) })
  .strict();

export type ActiveSessionsResponse = z.infer<typeof ActiveSessionsResponseSchema>;

export const SessionParamsSchema = z.object({ id: SessionHandleSchema }).strict();

export type SessionParams = z.infer<typeof SessionParamsSchema>;

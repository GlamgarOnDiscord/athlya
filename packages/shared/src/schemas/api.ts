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

import { ClassSchema, ExerciseSchema, ReservationSchema, UserSchema } from './domain.js';
import {
  ClassIdSchema,
  HexColorSchema,
  IsoDateTimeSchema,
  ReservationIdSchema,
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
    version: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.startsAt !== undefined ||
      v.durationMin !== undefined ||
      v.capacity !== undefined ||
      v.coachId !== undefined,
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

/* ------------------------------------------------------------------ */
/*  reservations — /v1/reservations                                    */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/reservations`. The `Idempotency-Key` header provides at-most-
 * once semantics (Requirement 8.5, 20.1) and is handled by the API
 * gateway middleware, not by this body schema.
 */
export const BookingRequestSchema = z
  .object({
    classId: ClassIdSchema,
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

/* ------------------------------------------------------------------ */
/*  sessions — /v1/sessions                                            */
/* ------------------------------------------------------------------ */

/**
 * `POST /v1/sessions`. `studioId` is optional for solo workouts done
 * outside a partner studio (Requirement 12.1).
 */
export const LogSessionRequestSchema = z
  .object({
    startedAt: IsoDateTimeSchema,
    durationMin: z.number().int().positive().optional(),
    exercises: z.array(ExerciseSchema).max(50),
    notes: z.string().max(2000).optional(),
    studioId: StudioIdSchema.optional(),
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
  .strict();

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

/* ------------------------------------------------------------------ */
/*  studios — /v1/studios/*                                            */
/* ------------------------------------------------------------------ */

/**
 * `GET /v1/studios/me` response — slice B9.1.
 *
 * Returns the caller's tenant root row (resolved from `claims.studioId`)
 * with the columns the front-end needs to drive its theming and admin
 * surfaces:
 *
 *   • `id`, `slug`, `name` — identity / addressing fields.
 *   • `brandColor` — `#RRGGBB` hex pair fed straight into
 *     `buildBrandColorCss(...)` from `@athlya/shared/theming` to retint
 *     the UI without a second round-trip.
 *   • `brandLogo` — optional URL or `null`. The current `studios` table
 *     does not yet carry a column for the logo (Vague 23 keeps the
 *     migration footprint zero); the field is exposed as
 *     nullable + optional so the API can ship `null` until the schema
 *     adds the column.
 */
export const StudioMeResponseSchema = z
  .object({
    id: UuidSchema,
    slug: SlugSchema,
    name: z.string().min(1).max(120),
    brandColor: HexColorSchema,
    brandLogo: z.url().nullable().optional(),
  })
  .strict();

export type StudioMeResponse = z.infer<typeof StudioMeResponseSchema>;

/**
 * `PATCH /v1/studios/me` (admin only) — slice B9.2.
 *
 * Whitelists the three editable fields. At least one must be present so
 * the server does not waste a round-trip on an empty patch. The strict
 * shape ensures no surprise column (e.g. `slug`, `id`) can be patched
 * via this endpoint — those mutations require a dedicated admin path.
 *
 * `brandColor` MUST additionally pass a WCAG 2.2 AA contrast check
 * server-side against either `#FFFFFF` or `#000000` (whichever is the
 * compagnion paired by the theming helper) before the row is updated.
 * That check lives in the route handler — Zod can only enforce the
 * regex shape, not the perceptual contrast.
 */
export const UpdateStudioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    brandColor: HexColorSchema.optional(),
    brandLogo: z.url().nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.brandColor !== undefined || v.brandLogo !== undefined, {
    message: 'must patch at least one of { name, brandColor, brandLogo }',
  });

export type UpdateStudioRequest = z.infer<typeof UpdateStudioRequestSchema>;

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

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

import {
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
const refineDateRange = <T extends z.ZodObject<{ from: typeof IsoDateTimeSchema; to: typeof IsoDateTimeSchema }>>(
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
            .string()
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
        password: z.string().min(8).max(72),
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
            .string()
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
        password: z.string().min(1).max(72),
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
 * `POST /v1/classes`. `coachId` is optional — classes without a coach are
 * legal (e.g. open-gym hours). Requirement 6.1–6.4.
 */
export const CreateClassRequestSchema = z
    .object({
        title: z.string().trim().min(1).max(200),
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
    .refine(
        (v) =>
            v.name !== undefined ||
            v.brandColor !== undefined ||
            v.brandLogo !== undefined,
        { message: 'must patch at least one of { name, brandColor, brandLogo }' },
    );

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

/**
 * Typed event contracts for the Athlya Event Bus.
 *
 * Every row in a domain service's transactional `outbox` table, every
 * message on Cloudflare Queues and every QStash-scheduled job flows
 * through the {@link AthlyaEventSchema} discriminated union below. The
 * union is the single source of truth for:
 *
 *   - runtime validation at publish time (producers) and consume time
 *     (`Notifications_Service`, analytics sinks, …),
 *   - the inferred TypeScript shape used by publishers / consumers,
 *   - the list of accepted `type` values enforced by the router.
 *
 * Envelope fields are identical for every event so the bus layer, the
 * dedup layer (Requirement 17.4) and the outbox worker (Requirement
 * 16.4) can treat a message opaquely until a handler discriminates on
 * `type`.
 *
 * Related requirements:
 *   - Requirement 16.1 — publish on commit.
 *   - Requirement 16.2 — outbox on bus failure.
 *   - Requirement 17.1 — consent-gated delivery.
 *   - Requirement 17.3 — `reservation.reminder` 1 h before `startsAt`.
 *   - Requirement 17.4 — dedup on `event.id` in Redis.
 *   - Requirement 18.4 — `billing.subscription.started`.
 *   - Requirement 18.5 — `billing.subscription.failed`.
 *   - Requirement 21.2 — payloads deserialize into typed domain values.
 */

import { z } from 'zod';

import {
  ClassIdSchema,
  IsoDateTimeSchema,
  ReservationIdSchema,
  StudioIdSchema,
  UserIdSchema,
  UuidSchema,
} from './schemas/primitives.js';

/* ------------------------------------------------------------------ */
/*  Envelope                                                           */
/* ------------------------------------------------------------------ */

/**
 * Fields every Athlya event carries, regardless of the concrete
 * `type` / `payload` pairing. Kept as a builder rather than a single
 * `z.object` so `z.discriminatedUnion('type', …)` below can keep each
 * arm's `type` field as a distinct `z.literal(...)` — discriminated
 * unions cannot be built from a shared schema with a generic
 * `z.string()` discriminator.
 *
 *   - `id`           Globally unique event id. Used as the dedup key
 *                    by the Notifications_Service (Requirement 17.4).
 *   - `type`         Literal discriminator (see each arm below).
 *   - `occurredAt`   ISO-8601 datetime with an explicit UTC offset
 *                    (`Z` or `±HH:MM`). Plain-date strings are rejected
 *                    so downstream time-series sinks (Tinybird) never
 *                    receive a timestamp that needs a guess at the
 *                    origin timezone.
 *   - `studioId`     Optional tenant scope. Present for every event
 *                    bound to a studio (reservations, members export,
 *                    …); absent for platform-wide events
 *                    (`auth.user.registered` before the studio join
 *                    flow runs). Callers that need to fan-out per
 *                    tenant should narrow on `type` rather than
 *                    asserting the field.
 */
function envelopeShape<TType extends string, TPayload extends z.ZodTypeAny>(
  typeLiteral: TType,
  payload: TPayload,
) {
  return z
    .object({
      id: UuidSchema,
      type: z.literal(typeLiteral),
      occurredAt: IsoDateTimeSchema,
      studioId: StudioIdSchema.optional(),
      payload,
    })
    .strict();
}

/* ------------------------------------------------------------------ */
/*  Reservation events                                                 */
/* ------------------------------------------------------------------ */

/** Payload shared by every reservation lifecycle event. */
const ReservationLifecyclePayloadSchema = z
  .object({
    reservationId: ReservationIdSchema,
    classId: ClassIdSchema,
    userId: UserIdSchema,
  })
  .strict();

/**
 * `reservation.created` — emitted on successful booking commit
 * (Requirement 8.1, 16.1). Triggers the QStash-scheduled
 * `reservation.reminder` job (Requirement 17.3).
 */
export const ReservationCreatedEventSchema = envelopeShape(
  'reservation.created',
  ReservationLifecyclePayloadSchema,
);
export type ReservationCreatedEvent = z.infer<typeof ReservationCreatedEventSchema>;

/**
 * `reservation.waitlisted` — emitted when capacity is full and the
 * user joins the waitlist (Requirement 8.2). `position` is 1-based.
 */
export const ReservationWaitlistedEventSchema = envelopeShape(
  'reservation.waitlisted',
  ReservationLifecyclePayloadSchema.extend({
    position: z.number().int().positive(),
  }).strict(),
);
export type ReservationWaitlistedEvent = z.infer<typeof ReservationWaitlistedEventSchema>;

/**
 * `reservation.cancelled` — emitted on cancellation whether initiated
 * by the member or by an admin (Requirement 9.1–9.5). Consumed by the
 * Notifications_Service to send the cancellation email.
 */
export const ReservationCancelledEventSchema = envelopeShape(
  'reservation.cancelled',
  ReservationLifecyclePayloadSchema,
);
export type ReservationCancelledEvent = z.infer<typeof ReservationCancelledEventSchema>;

/**
 * `reservation.promoted` — emitted when a waitlisted reservation is
 * promoted to confirmed after a cancellation frees a slot
 * (Requirement 10.3).
 */
export const ReservationPromotedEventSchema = envelopeShape(
  'reservation.promoted',
  ReservationLifecyclePayloadSchema,
);
export type ReservationPromotedEvent = z.infer<typeof ReservationPromotedEventSchema>;

/**
 * `reservation.reminder` — emitted by the QStash job scheduled 1 hour
 * before the class starts (Requirement 17.3). `startsAt` is carried so
 * the Notifications_Service can render the reminder without re-reading
 * the class.
 */
export const ReservationReminderEventSchema = envelopeShape(
  'reservation.reminder',
  ReservationLifecyclePayloadSchema.extend({
    startsAt: IsoDateTimeSchema,
  }).strict(),
);
export type ReservationReminderEvent = z.infer<typeof ReservationReminderEventSchema>;

/* ------------------------------------------------------------------ */
/*  Auth events                                                        */
/* ------------------------------------------------------------------ */

/**
 * `auth.user.registered` — emitted on successful account creation
 * (Requirement 1.1, 1.4). Consumed by analytics and by the
 * Notifications_Service for the welcome email.
 *
 * Sprint-2 SP2.2 (Vague 30) — finding S5-005 [HIGH][PROD-RISK]:
 * the `email` field was removed from the payload because it
 * persisted in the `outbox.payload` JSONB column indefinitely
 * (no purge job at the time of audit), in clear text, even after
 * the user invoked their right to erasure (`DELETE /v1/auth/me`).
 * The notifications consumer fetches the recipient's current email
 * from `RecipientRepo.getRecipient(userId)`, so the field was
 * redundant on the bus envelope and dropping it is a strict
 * minimisation win (RGPD Art 5§1.c) without any consumer impact.
 */
export const AuthUserRegisteredEventSchema = envelopeShape(
  'auth.user.registered',
  z
    .object({
      userId: UserIdSchema,
    })
    .strict(),
);
export type AuthUserRegisteredEvent = z.infer<typeof AuthUserRegisteredEventSchema>;

/**
 * `auth.user.deleted` — emitted when a user account is hard-deleted
 * after the 30-day grace window (Requirement 5.1, 5.3). Triggers the
 * audit-log anonymisation routine on the consumer side.
 */
export const AuthUserDeletedEventSchema = envelopeShape(
  'auth.user.deleted',
  z
    .object({
      userId: UserIdSchema,
    })
    .strict(),
);
export type AuthUserDeletedEvent = z.infer<typeof AuthUserDeletedEventSchema>;

/**
 * `auth.suspicious.refresh.reuse` — emitted when the gateway detects
 * that a refresh token already rotated out of a session family is
 * presented again (Sprint-2 SP2.1, audit finding S2-004). The
 * presence of two live copies of the same refresh token in the wild
 * is a near-certain signal of token theft (XSS exfiltration, log
 * leak, malware on device, …); the auth service revokes every sid
 * in the family rooted at `rootSid`, writes a
 * `token.refresh.reuse.detected` audit row, and emits this event so
 * downstream consumers (alerting, ops dashboards, future
 * notify-the-user fan-out) can react.
 *
 * Payload is intentionally PII-minimal — only the opaque sids and
 * the `userId` flow through. No IP, no user-agent, no email; those
 * are correlatable from the audit row keyed on `actorId = userId`
 * if forensics ever need them.
 */
export const AuthSuspiciousRefreshReuseEventSchema = envelopeShape(
  'auth.suspicious.refresh.reuse',
  z
    .object({
      userId: UserIdSchema,
      rootSid: z.string().min(1).max(128),
    })
    .strict(),
);
export type AuthSuspiciousRefreshReuseEvent = z.infer<typeof AuthSuspiciousRefreshReuseEventSchema>;

/**
 * `auth.suspicious.login.anomaly` — emitted when the gateway
 * detects that a successful login originates from a country or
 * user-agent family that does not match the user's last known
 * login (Sprint-12 SP12.8, Epic B3.4).
 *
 * "Anomaly" is intentionally narrow: we compare ISO-3166 country
 * code (from the Cloudflare `CF-IPCountry` header) and the
 * coarse-grained UA family (Chrome / Firefox / Safari / Edge /
 * Mobile / Bot / Other). A change in either dimension fires the
 * event. Finer grain (city, exact device fingerprint) is left for
 * a later iteration — the false-positive rate would be too high.
 *
 * The event drives a transactional notification to the member
 * ("a new sign-in from $country"). It is NOT a hard block;
 * legitimate travellers and browser changes are common enough that
 * forcing reauth would degrade UX more than it would harden
 * security.
 *
 * Payload stays PII-minimal: the `country` is a 2-letter ISO code,
 * the `uaFamily` is a coarse string. We do NOT persist the IP or
 * the full UA string in this event — those live in the audit log.
 */
export const AuthSuspiciousLoginAnomalyEventSchema = envelopeShape(
  'auth.suspicious.login.anomaly',
  z
    .object({
      userId: UserIdSchema,
      country: z
        .string()
        .length(2)
        .regex(/^[A-Z]{2}$/u),
      previousCountry: z
        .string()
        .length(2)
        .regex(/^[A-Z]{2}$/u)
        .nullable(),
      uaFamily: z.enum(['chrome', 'firefox', 'safari', 'edge', 'mobile', 'bot', 'other']),
      previousUaFamily: z
        .enum(['chrome', 'firefox', 'safari', 'edge', 'mobile', 'bot', 'other'])
        .nullable(),
    })
    .strict(),
);
export type AuthSuspiciousLoginAnomalyEvent = z.infer<typeof AuthSuspiciousLoginAnomalyEventSchema>;

/* ------------------------------------------------------------------ */
/*  Billing events                                                     */
/* ------------------------------------------------------------------ */

/**
 * `billing.subscription.started` — emitted after a Stripe
 * `customer.subscription.created` webhook is verified and persisted
 * (Requirement 18.4). `plan` matches the Stripe price nickname; kept
 * as a free-form string so the billing service can introduce new
 * plans without a shared-package release.
 */
export const BillingSubscriptionStartedEventSchema = envelopeShape(
  'billing.subscription.started',
  z
    .object({
      userId: UserIdSchema,
      subscriptionId: z.string().min(1).max(120),
      plan: z.string().min(1).max(80),
      startsAt: IsoDateTimeSchema,
    })
    .strict(),
);
export type BillingSubscriptionStartedEvent = z.infer<typeof BillingSubscriptionStartedEventSchema>;

/**
 * `billing.subscription.failed` — emitted after a Stripe
 * `invoice.payment_failed` webhook (Requirement 18.5). Consumed by
 * the Notifications_Service to send the dunning email.
 */
export const BillingSubscriptionFailedEventSchema = envelopeShape(
  'billing.subscription.failed',
  z
    .object({
      userId: UserIdSchema,
      subscriptionId: z.string().min(1).max(120),
      reason: z.string().min(1).max(500),
    })
    .strict(),
);
export type BillingSubscriptionFailedEvent = z.infer<typeof BillingSubscriptionFailedEventSchema>;

/* ------------------------------------------------------------------ */
/*  Members events                                                     */
/* ------------------------------------------------------------------ */

/**
 * `members.export.requested` — emitted (directly to QStash) when a
 * member asks for their RGPD data export (Requirement 4.1). Carries
 * the freshly-created `exportJobId` so the background worker can look
 * up the matching `export_jobs` row and start streaming. No `studioId`
 * field is required on the payload — the export is scoped to a user,
 * and the envelope's optional `studioId` remains available when the
 * producer wants to carry tenant context for analytics fan-out.
 */
export const MembersExportRequestedEventSchema = envelopeShape(
  'members.export.requested',
  z
    .object({
      userId: UserIdSchema,
      exportJobId: UuidSchema,
    })
    .strict(),
);
export type MembersExportRequestedEvent = z.infer<typeof MembersExportRequestedEventSchema>;

/**
 * `members.export.completed` — emitted by the background worker that
 * assembles a member data export (Requirement 4.1, 4.2). The signed
 * `downloadUrl` is ephemeral; `expiresAt` is carried so the
 * Notifications_Service can render the email copy without a round-trip.
 */
export const MembersExportCompletedEventSchema = envelopeShape(
  'members.export.completed',
  z
    .object({
      userId: UserIdSchema,
      exportJobId: UuidSchema,
      downloadUrl: z.url().max(2048),
      expiresAt: IsoDateTimeSchema,
    })
    .strict(),
);
export type MembersExportCompletedEvent = z.infer<typeof MembersExportCompletedEventSchema>;

/* ------------------------------------------------------------------ */
/*  Union                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ordered, frozen list of every event `type` currently recognised by
 * the platform. Exposed as a `readonly` tuple so it can drive:
 *
 *   - router-level allow-lists (`if (!EVENT_TYPES.includes(raw.type))`),
 *   - documentation generators,
 *   - infra tooling that provisions one Cloudflare Queue topic per
 *     event family.
 *
 * Order is stable: new events MUST be appended at the end to keep
 * downstream consumers (that may rely on ordinal positions for
 * metrics labels) behaviour-preserving.
 */
export const EVENT_TYPES = [
  'reservation.created',
  'reservation.waitlisted',
  'reservation.cancelled',
  'reservation.promoted',
  'reservation.reminder',
  'auth.user.registered',
  'auth.user.deleted',
  'auth.suspicious.refresh.reuse',
  'auth.suspicious.login.anomaly',
  'billing.subscription.started',
  'billing.subscription.failed',
  'members.export.completed',
  'members.export.requested',
] as const;

/** Union of the literal `type` values above. */
export type AthlyaEventType = (typeof EVENT_TYPES)[number];

/**
 * The full Athlya event contract. Every producer and every consumer
 * MUST validate raw payloads against this schema before acting on
 * them — a malformed envelope indicates either a bus corruption or a
 * version drift between services and must never be dispatched.
 */
export const AthlyaEventSchema = z.discriminatedUnion('type', [
  ReservationCreatedEventSchema,
  ReservationWaitlistedEventSchema,
  ReservationCancelledEventSchema,
  ReservationPromotedEventSchema,
  ReservationReminderEventSchema,
  AuthUserRegisteredEventSchema,
  AuthUserDeletedEventSchema,
  AuthSuspiciousRefreshReuseEventSchema,
  AuthSuspiciousLoginAnomalyEventSchema,
  BillingSubscriptionStartedEventSchema,
  BillingSubscriptionFailedEventSchema,
  MembersExportCompletedEventSchema,
  MembersExportRequestedEventSchema,
]);

/** Inferred discriminated union type covering every Athlya event. */
export type AthlyaEvent = z.infer<typeof AthlyaEventSchema>;

/* ------------------------------------------------------------------ */
/*  Parsing helper                                                     */
/* ------------------------------------------------------------------ */

/**
 * Issue surfaced by {@link InvalidEventError}. Mirrors the minimal
 * subset of {@link z.core.$ZodIssue} that consumers actually render in
 * logs / problem details — lifted to its own type so error handlers
 * don't need to depend on Zod internals.
 */
export interface InvalidEventIssue {
  /** Dotted path to the offending field, e.g. `payload.position`. */
  readonly path: string;
  /** Zod issue code (`invalid_type`, `too_small`, …). */
  readonly code: string;
  /** Human-readable message from the schema. */
  readonly message: string;
}

/**
 * Thrown by {@link parseEvent} when the input does not match the
 * {@link AthlyaEventSchema}. Carries the underlying issue list so the
 * bus router can decide between "route to DLQ" and "retry" depending
 * on whether the failure is structural (malformed) or transient.
 */
export class InvalidEventError extends Error {
  public override readonly name = 'InvalidEventError';

  /** Normalised issues extracted from the Zod error. */
  public readonly issues: ReadonlyArray<InvalidEventIssue>;

  public constructor(issues: ReadonlyArray<InvalidEventIssue>) {
    super(
      `Invalid Athlya event: ${issues.map((i) => `${i.path || '<root>'} ${i.message}`).join('; ')}`,
    );
    this.issues = issues;
  }
}

/**
 * Strict parser for raw bus payloads. Returns the typed
 * {@link AthlyaEvent} on success; throws {@link InvalidEventError}
 * with a normalised issue list otherwise.
 *
 * We prefer throwing over returning a `Result<…>` because every
 * consumer (Notifications, Analytics, …) already sits behind the
 * Cloudflare Queues retry / DLQ machinery — a thrown error surfaces
 * as a visible failure in the queue dashboard, whereas a silent
 * `Result.Err` would swallow the protocol violation.
 */
export function parseEvent(raw: unknown): AthlyaEvent {
  const result = AthlyaEventSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issues: InvalidEventIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
  throw new InvalidEventError(issues);
}

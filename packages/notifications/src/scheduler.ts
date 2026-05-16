/**
 * 1-hour reservation reminder scheduler — task 9.6 of the Athlya
 * implementation plan.
 *
 * Requirement 17.3 mandates that "when a `reservation.created` event
 * is consumed, the Notifications_Service SHALL schedule a
 * `reservation.reminder` job in Upstash QStash to fire exactly 1 hour
 * before the class `startsAt`". This module owns the scheduling half
 * of that contract; the matching consumer that handles the fired
 * `reservation.reminder` event lives in `./consumer.ts` (task 9.5).
 *
 * The module is intentionally framework-free. It declares two
 * Dependency-Injection ports — a {@link ReminderScheduler} for the
 * QStash side and a {@link ReservationLookupRepo} for the class
 * starts-at lookup — and exposes pure async functions over them.
 *
 * Production wiring (outside this package):
 *
 *   - `ReminderScheduler` → Upstash `@upstash/qstash` client calling
 *     `publishJSON` with a `notBefore` header set to the Unix-seconds
 *     timestamp of `fireAt`; the target URL is the
 *     `reservation.reminder` webhook that re-enters the Notifications
 *     consumer.
 *   - `ReservationLookupRepo` → Drizzle query against the `classes`
 *     table returning the `starts_at` column for a given `class_id`.
 *
 * Unit tests in `./__tests__/scheduler.test.ts` stub both ports with
 * `vi.fn()` so the suite never reaches the network.
 *
 * ### Fire-at computation and boundary handling
 *
 * `fireAt = startsAt - 1h`. A reservation booked less than an hour
 * before the class starts is too late to meaningfully remind the
 * member about — the user is almost certainly already heading to the
 * studio — so we short-circuit with `{ kind: 'skipped_too_soon' }`.
 *
 * The strict inequality `fireAt < now` governs the skip. When
 * `startsAt` is *exactly* `now + 1h` the computed `fireAt` equals
 * `now`; per the task acceptance criteria we treat that boundary as
 * acceptable and hand QStash a `fireAt = now`. QStash's own
 * `notBefore` semantics accept a timestamp in the (immediate) past
 * and fire as soon as possible, so no edge-case workaround is
 * required on the adapter side.
 *
 * Related requirements: 17.3.
 */

import type { ReservationCreatedEvent } from '@athlya/shared/events';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reminder lead time in milliseconds. Requirement 17.3 pins it at
 * exactly one hour — exposed as a named constant so tests and
 * adapters (e.g. a future "24 h reminder" variant) can reference the
 * same value without a magic `3_600_000`.
 */
export const REMINDER_LEAD_MS = 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Command shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * Payload handed to {@link ReminderScheduler} (method: `scheduleReminder`).
 *
 * The adapter serialises this object as the QStash message body so
 * the downstream `reservation.reminder` webhook can reconstruct the
 * event envelope verbatim — including the `startsAt` field carried on
 * `ReservationReminderEventSchema` in `@athlya/shared/events`.
 *
 *   - `reservationId`, `classId`, `userId`, `studioId` — routing
 *     metadata. `studioId` is required here (unlike the optional
 *     envelope field) because the reminder consumer needs tenant
 *     context to enforce RLS on the recipient lookup.
 *   - `startsAt` — ISO-8601 UTC datetime, echoed back so the
 *     reminder template can render "starts at …" without a second DB
 *     round-trip.
 *   - `fireAt` — ISO-8601 UTC datetime. The adapter converts this to
 *     the QStash `notBefore` header (Unix seconds). A `fireAt` in the
 *     past is legal — QStash will fire immediately.
 */
export interface ReminderScheduleCommand {
    readonly reservationId: string;
    readonly classId: string;
    readonly userId: string;
    readonly studioId: string;
    readonly startsAt: string;
    readonly fireAt: string;
}

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * Scheduler port used to enqueue a deferred reminder job.
 *
 * Production wires this to an `@upstash/qstash` client whose
 * `publishJSON` call carries a `notBefore` header equal to
 * `Math.floor(fireAtMs / 1000)`. The port stays framework-free so
 * tests can replace it with a `vi.fn()` and assert on the command
 * shape directly.
 *
 * Implementations MUST throw on transient QStash failures so the
 * caller (and the surrounding Cloudflare Queues retry machinery —
 * Requirement 16.5) can replay. A resolved promise signals QStash
 * acknowledged the job.
 */
export interface ReminderScheduler {
    scheduleReminder(command: ReminderScheduleCommand): Promise<void>;
}

/**
 * Lookup port for the class's `starts_at` timestamp.
 *
 * The `reservation.created` event payload carries the `classId` but
 * not the class start time — keeping the envelope narrow avoids
 * leaking the full class projection onto the bus (Requirement 21.2).
 * Consumers that need `startsAt` read it from the database through
 * this port.
 *
 * Returns the ISO-8601 UTC datetime on hit, `null` when the class no
 * longer exists (e.g. the class was deleted between booking and the
 * bus redelivery window). A `null` return surfaces as
 * `{ kind: 'skipped_class_not_found' }`.
 */
export interface ReservationLookupRepo {
    getClassStartsAt(classId: string): Promise<string | null>;
}

/**
 * Injectable clock. `number` is Unix-ms to match `Date.now()` and
 * the shape used by `@athlya/reservations/checkin`. Defaults to
 * `Date.now` in production.
 */
export type Clock = () => number;

/* ------------------------------------------------------------------ */
/*  Input / result                                                     */
/* ------------------------------------------------------------------ */

/**
 * Minimal reservation projection accepted by
 * {@link scheduleReservationReminder}. Kept small on purpose — the
 * scheduler only needs the four fields the reminder command carries
 * plus `startsAt`. Callers that hold a richer row (Drizzle
 * `ReservationRow`) can spread the subset in, tests can build a
 * plain literal.
 */
export interface ReservationReminderInput {
    readonly reservationId: string;
    readonly classId: string;
    readonly userId: string;
    /** Class start time as ISO-8601 UTC datetime. */
    readonly startsAt: string;
}

/**
 * Outcome of a single scheduling attempt.
 *
 *   - `'scheduled'`               — the scheduler port was called with
 *     the computed `fireAt`. The adapter owns the actual QStash side
 *     effect; a resolved promise means the job is accepted.
 *   - `'skipped_too_soon'`        — `fireAt < now`. Requirement 17.3
 *     says the reminder fires exactly 1 h before start, not a shorter
 *     lead; a booking made less than 1 h ahead simply gets no
 *     reminder. The `fireAt` is reported back for observability.
 *   - `'skipped_class_not_found'` — only returned by
 *     {@link onReservationCreated} when the class lookup returns
 *     `null`. Never produced by the inner
 *     {@link scheduleReservationReminder} because it takes
 *     `startsAt` as input.
 */
export type ScheduleResult =
    | { readonly kind: 'scheduled'; readonly fireAt: string }
    | { readonly kind: 'skipped_too_soon'; readonly fireAt: string }
    | { readonly kind: 'skipped_class_not_found' };

/* ------------------------------------------------------------------ */
/*  scheduleReservationReminder                                        */
/* ------------------------------------------------------------------ */

/**
 * Argument bag accepted by {@link scheduleReservationReminder}. Named
 * fields (rather than positional args) so call sites stay readable at
 * the two-or-three-call cadence the consumer needs.
 */
export interface ScheduleReservationReminderArgs {
    /** Reservation projection — just enough to build the command. */
    readonly reservation: ReservationReminderInput;
    /** Tenant owning the reservation. Echoed into the command. */
    readonly studioId: string;
    /** Scheduler port (QStash in prod, `vi.fn()` in tests). */
    readonly scheduler: ReminderScheduler;
    /** Clock override. Defaults to `Date.now`. */
    readonly clock?: Clock;
}

/**
 * Compute `fireAt = startsAt - 1h` and enqueue the reminder job.
 *
 * Flow:
 *
 *   1. Parse `reservation.startsAt` into Unix-ms. A non-parseable
 *      string surfaces as a thrown `RangeError` — this is a protocol
 *      violation (envelope validation should have caught it
 *      upstream), not a business outcome.
 *   2. Subtract {@link REMINDER_LEAD_MS}. The result is the `fireAt`
 *      we hand to the scheduler.
 *   3. If `fireAt < now`, short-circuit with
 *      `{ kind: 'skipped_too_soon', fireAt }`. The boundary case
 *      `fireAt === now` (i.e. class starts in exactly 1 h) is
 *      explicitly allowed — QStash will fire the job immediately
 *      and the consumer's dedup window (24 h, Req 17.4) absorbs any
 *      redelivery.
 *   4. Otherwise, call `scheduler.scheduleReminder` with the full
 *      {@link ReminderScheduleCommand} and return
 *      `{ kind: 'scheduled', fireAt }`.
 *
 * The function never throws on expected business outcomes; it only
 * propagates unexpected failures (malformed input, port outage) so
 * the surrounding Cloudflare Queues retry budget can replay.
 */
export async function scheduleReservationReminder(
    args: ScheduleReservationReminderArgs,
): Promise<ScheduleResult> {
    const { reservation, studioId, scheduler } = args;
    const now = (args.clock ?? Date.now)();

    const startsAtMs = Date.parse(reservation.startsAt);
    if (Number.isNaN(startsAtMs)) {
        // Defense-in-depth: `parseEvent` on the upstream envelope
        // rejects non-ISO strings, but this helper is also called
        // directly from unit seams. Fail loud rather than silently
        // scheduling a job with `fireAt = "Invalid Date"`.
        throw new RangeError(
            `scheduleReservationReminder: invalid startsAt ${reservation.startsAt}`,
        );
    }

    const fireAtMs = startsAtMs - REMINDER_LEAD_MS;
    const fireAtIso = new Date(fireAtMs).toISOString();

    if (fireAtMs < now) {
        return { kind: 'skipped_too_soon', fireAt: fireAtIso };
    }

    await scheduler.scheduleReminder({
        reservationId: reservation.reservationId,
        classId: reservation.classId,
        userId: reservation.userId,
        studioId,
        startsAt: reservation.startsAt,
        fireAt: fireAtIso,
    });

    return { kind: 'scheduled', fireAt: fireAtIso };
}

/* ------------------------------------------------------------------ */
/*  onReservationCreated                                               */
/* ------------------------------------------------------------------ */

/**
 * Dependency bag accepted by {@link onReservationCreated}.
 *
 * The lookup repo is split out from the scheduler because the two
 * adapters live in different infrastructure layers (Postgres for the
 * lookup, QStash for the scheduler) and will almost always be
 * instantiated from different binding sets in the Cloudflare Worker
 * env.
 */
export interface OnReservationCreatedDeps {
    readonly scheduler: ReminderScheduler;
    readonly repo: ReservationLookupRepo;
    readonly clock?: Clock;
}

/**
 * Handle a `reservation.created` event: resolve the class's
 * `starts_at` and delegate to {@link scheduleReservationReminder}.
 *
 * Flow:
 *
 *   1. Call `repo.getClassStartsAt(event.payload.classId)`. A `null`
 *      return means the class was deleted between the booking commit
 *      and this replay — there's nothing to remind about. Surface
 *      `{ kind: 'skipped_class_not_found' }`.
 *   2. Envelope `studioId` is required for the scheduler command
 *      (the reminder consumer uses it for RLS). `reservation.created`
 *      always carries one upstream (see `ReservationCreatedEventSchema`
 *      in `@athlya/shared/events` — the field is envelope-optional
 *      only to cover platform-wide events such as
 *      `auth.user.registered`), so a missing field here is a
 *      protocol violation. We surface it as a thrown error rather
 *      than a business outcome so the bus can replay with
 *      higher-priority alerting.
 *   3. Build the {@link ReservationReminderInput} from
 *      `event.payload` + the looked-up `startsAt` and forward to the
 *      inner helper.
 *
 * The outer helper is deliberately thin — it's an *adapter between
 * the event envelope and the reminder-input shape*, so the event
 * envelope can evolve without churning the scheduling logic in
 * {@link scheduleReservationReminder}.
 */
export async function onReservationCreated(
    event: ReservationCreatedEvent,
    deps: OnReservationCreatedDeps,
): Promise<ScheduleResult> {
    const { scheduler, repo } = deps;

    const startsAt = await repo.getClassStartsAt(event.payload.classId);
    if (startsAt === null) {
        return { kind: 'skipped_class_not_found' };
    }

    if (event.studioId === undefined) {
        // `reservation.created` always carries a studio id in
        // practice; surface the protocol violation as a thrown error
        // so the Cloudflare Queues DLQ picks it up (Req 16.5).
        throw new Error(
            `onReservationCreated: reservation.created event ${event.id} missing studioId`,
        );
    }

    const clock = deps.clock;

    return scheduleReservationReminder({
        reservation: {
            reservationId: event.payload.reservationId,
            classId: event.payload.classId,
            userId: event.payload.userId,
            startsAt,
        },
        studioId: event.studioId,
        scheduler,
        // Spread pattern keeps `exactOptionalPropertyTypes` happy —
        // the inner helper declares `clock?: Clock`, and assigning
        // `clock: undefined` would violate the strict optional
        // semantics.
        ...(clock !== undefined ? { clock } : {}),
    });
}

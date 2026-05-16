/**
 * Unit tests for `@athlya/notifications/scheduler`.
 *
 * Covers task 9.6 — scheduling the 1-hour `reservation.reminder` job
 * on QStash:
 *
 *   - **Happy path**: `startsAt = now + 4h` → the scheduler is called
 *     once with `fireAt = startsAt - 1h`.
 *   - **Too soon**: `startsAt = now + 30min` → returns
 *     `skipped_too_soon`; the scheduler is NOT called (Req 17.3 —
 *     the reminder fires exactly 1 h before start, not a shorter
 *     lead; a shorter-notice booking simply gets no reminder).
 *   - **Boundary**: `startsAt = now + 1h` exactly → `fireAt = now`
 *     is treated as acceptable and scheduled with a fire-at equal to
 *     the current instant (QStash fires immediately for a
 *     not-in-the-past `notBefore`).
 *   - **onReservationCreated dispatch**: given a
 *     `reservation.created` envelope, the helper looks up
 *     `classStartsAt` and forwards to `scheduleReminder` on hit, or
 *     surfaces `skipped_class_not_found` on miss.
 *
 * Ports are hand-rolled `vi.fn()` doubles — no QStash client, no
 * Drizzle, no Redis. Matches the style used in `./consumer.test.ts`.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
    REMINDER_LEAD_MS,
    onReservationCreated,
    scheduleReservationReminder,
    type ReminderScheduler,
    type ReservationLookupRepo,
    type ReservationReminderInput,
} from '../scheduler.js';

import type { ReservationCreatedEvent } from '@athlya/shared/events';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const EVENT_ID = 'a1b2c3d4-5678-4abc-89ef-1234567890ab';
const RESERVATION_ID = 'e5f6a7b8-9abc-4ef0-bfef-567890abcdef';
const CLASS_ID = 'd4e5f6a7-89ab-4def-bcef-4567890abcde';
const USER_ID = 'c3d4e5f6-789a-4cde-abef-34567890abcd';
const STUDIO_ID = 'b2c3d4e5-6789-4bcd-9aef-234567890abc';

/**
 * Frozen wall-clock (Unix ms). `new Date(FROZEN_NOW).toISOString()` is
 * `2026-02-03T06:00:00.000Z` — picked so window arithmetic in the
 * tests reads nicely.
 */
const FROZEN_NOW = Date.parse('2026-02-03T06:00:00.000Z');
const FIXED_CLOCK = (): number => FROZEN_NOW;

/** Build the minimal reservation input the inner helper accepts. */
function reservationInput(
    overrides: Partial<ReservationReminderInput> = {},
): ReservationReminderInput {
    return {
        reservationId: RESERVATION_ID,
        classId: CLASS_ID,
        userId: USER_ID,
        startsAt: new Date(FROZEN_NOW + 4 * 60 * 60 * 1000).toISOString(),
        ...overrides,
    };
}

/** Build a `reservation.created` envelope for the outer helper. */
function createdEvent(
    overrides: Partial<ReservationCreatedEvent> = {},
): ReservationCreatedEvent {
    return {
        id: EVENT_ID,
        type: 'reservation.created',
        occurredAt: new Date(FROZEN_NOW).toISOString(),
        studioId: STUDIO_ID,
        payload: {
            reservationId: RESERVATION_ID,
            classId: CLASS_ID,
            userId: USER_ID,
        },
        ...overrides,
    } as ReservationCreatedEvent;
}

/** Build a fresh scheduler double resolving to `void`. */
function makeScheduler(): {
    readonly scheduler: ReminderScheduler;
    readonly scheduleReminder: Mock<ReminderScheduler['scheduleReminder']>;
} {
    const scheduleReminder = vi
        .fn<ReminderScheduler['scheduleReminder']>()
        .mockResolvedValue();
    return { scheduler: { scheduleReminder }, scheduleReminder };
}

/** Build a fresh repo double configured with a canned `startsAt`. */
function makeRepo(startsAt: string | null): {
    readonly repo: ReservationLookupRepo;
    readonly getClassStartsAt: Mock<ReservationLookupRepo['getClassStartsAt']>;
} {
    const getClassStartsAt = vi
        .fn<ReservationLookupRepo['getClassStartsAt']>()
        .mockResolvedValue(startsAt);
    return { repo: { getClassStartsAt }, getClassStartsAt };
}

/* ================================================================== */
/*  Exported constant                                                  */
/* ================================================================== */

describe('REMINDER_LEAD_MS', () => {
    it('is exactly one hour in milliseconds', () => {
        // Req 17.3 pins the lead time at 1 h; guard against accidental
        // changes.
        expect(REMINDER_LEAD_MS).toBe(60 * 60 * 1000);
    });
});

/* ================================================================== */
/*  scheduleReservationReminder — happy path                           */
/* ================================================================== */

describe('scheduleReservationReminder — happy path', () => {
    it('schedules the reminder at startsAt - 1h when startsAt is now + 4h', async () => {
        // startsAt = now + 4h → fireAt = now + 3h.
        const startsAtMs = FROZEN_NOW + 4 * 60 * 60 * 1000;
        const expectedFireAtMs = startsAtMs - REMINDER_LEAD_MS;
        const expectedFireAtIso = new Date(expectedFireAtMs).toISOString();
        const startsAtIso = new Date(startsAtMs).toISOString();

        const { scheduler, scheduleReminder } = makeScheduler();

        const result = await scheduleReservationReminder({
            reservation: reservationInput({ startsAt: startsAtIso }),
            studioId: STUDIO_ID,
            scheduler,
            clock: FIXED_CLOCK,
        });

        expect(result).toEqual({
            kind: 'scheduled',
            fireAt: expectedFireAtIso,
        });
        expect(scheduleReminder).toHaveBeenCalledExactlyOnceWith({
            reservationId: RESERVATION_ID,
            classId: CLASS_ID,
            userId: USER_ID,
            studioId: STUDIO_ID,
            startsAt: startsAtIso,
            fireAt: expectedFireAtIso,
        });
    });
});

/* ================================================================== */
/*  scheduleReservationReminder — too soon                             */
/* ================================================================== */

describe('scheduleReservationReminder — too soon', () => {
    it('returns skipped_too_soon and does not call scheduler when startsAt is now + 30min', async () => {
        // fireAt = now + 30min - 1h = now - 30min → in the past.
        const startsAtMs = FROZEN_NOW + 30 * 60 * 1000;
        const expectedFireAtMs = startsAtMs - REMINDER_LEAD_MS;
        const expectedFireAtIso = new Date(expectedFireAtMs).toISOString();
        const startsAtIso = new Date(startsAtMs).toISOString();

        const { scheduler, scheduleReminder } = makeScheduler();

        const result = await scheduleReservationReminder({
            reservation: reservationInput({ startsAt: startsAtIso }),
            studioId: STUDIO_ID,
            scheduler,
            clock: FIXED_CLOCK,
        });

        expect(result).toEqual({
            kind: 'skipped_too_soon',
            fireAt: expectedFireAtIso,
        });
        expect(scheduleReminder).not.toHaveBeenCalled();
    });
});

/* ================================================================== */
/*  scheduleReservationReminder — boundary                             */
/* ================================================================== */

describe('scheduleReservationReminder — boundary', () => {
    it('schedules with fireAt = now when startsAt is exactly now + 1h', async () => {
        // startsAt = now + 1h → fireAt = now exactly. Acceptance
        // says this boundary is acceptable: the job fires as soon
        // as QStash picks it up.
        const startsAtMs = FROZEN_NOW + REMINDER_LEAD_MS;
        const expectedFireAtIso = new Date(FROZEN_NOW).toISOString();
        const startsAtIso = new Date(startsAtMs).toISOString();

        const { scheduler, scheduleReminder } = makeScheduler();

        const result = await scheduleReservationReminder({
            reservation: reservationInput({ startsAt: startsAtIso }),
            studioId: STUDIO_ID,
            scheduler,
            clock: FIXED_CLOCK,
        });

        expect(result).toEqual({
            kind: 'scheduled',
            fireAt: expectedFireAtIso,
        });
        expect(scheduleReminder).toHaveBeenCalledOnce();
        // The fireAt handed to the adapter equals the current instant.
        expect(scheduleReminder.mock.calls[0]?.[0].fireAt).toBe(
            expectedFireAtIso,
        );
    });
});

/* ================================================================== */
/*  onReservationCreated                                               */
/* ================================================================== */

describe('onReservationCreated', () => {
    it('looks up classStartsAt and delegates to scheduleReminder on hit', async () => {
        const startsAtMs = FROZEN_NOW + 4 * 60 * 60 * 1000;
        const startsAtIso = new Date(startsAtMs).toISOString();
        const expectedFireAtIso = new Date(
            startsAtMs - REMINDER_LEAD_MS,
        ).toISOString();

        const { scheduler, scheduleReminder } = makeScheduler();
        const { repo, getClassStartsAt } = makeRepo(startsAtIso);

        const result = await onReservationCreated(createdEvent(), {
            scheduler,
            repo,
            clock: FIXED_CLOCK,
        });

        expect(result).toEqual({
            kind: 'scheduled',
            fireAt: expectedFireAtIso,
        });
        expect(getClassStartsAt).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
        expect(scheduleReminder).toHaveBeenCalledExactlyOnceWith({
            reservationId: RESERVATION_ID,
            classId: CLASS_ID,
            userId: USER_ID,
            studioId: STUDIO_ID,
            startsAt: startsAtIso,
            fireAt: expectedFireAtIso,
        });
    });

    it('returns skipped_class_not_found when the repo returns null', async () => {
        const { scheduler, scheduleReminder } = makeScheduler();
        const { repo, getClassStartsAt } = makeRepo(null);

        const result = await onReservationCreated(createdEvent(), {
            scheduler,
            repo,
            clock: FIXED_CLOCK,
        });

        expect(result).toEqual({ kind: 'skipped_class_not_found' });
        expect(getClassStartsAt).toHaveBeenCalledExactlyOnceWith(CLASS_ID);
        // Critical: the scheduler must not be called when the class
        // is gone — there's nothing to remind about.
        expect(scheduleReminder).not.toHaveBeenCalled();
    });
});

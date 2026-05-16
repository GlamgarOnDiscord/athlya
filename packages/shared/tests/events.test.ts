/**
 * Unit tests for the `@athlya/shared/events` discriminated-union
 * contract.
 *
 * These tests guard three invariants the Event Bus layer (Requirements
 * 16, 17, 18) depends on:
 *
 *   1. Every well-formed event of each declared `type` parses
 *      successfully with a type-narrowed payload.
 *   2. An unknown `type` value is rejected by the discriminator (not
 *      silently accepted as an "empty" arm).
 *   3. `parseEvent` throws a typed {@link InvalidEventError} that
 *      surfaces the failing field path, so the bus can log / route
 *      to DLQ without re-parsing.
 *   4. `occurredAt` requires an explicit UTC offset — plain
 *      `YYYY-MM-DD` strings (or local-time datetimes without `Z`) are
 *      rejected so downstream time-series sinks never guess a zone.
 *
 * Related requirements: 16.1, 17.1, 17.3, 17.4, 18.4, 18.5, 21.2.
 */

import { describe, expect, it } from 'vitest';

import {
    AthlyaEventSchema,
    AuthUserDeletedEventSchema,
    AuthUserRegisteredEventSchema,
    BillingSubscriptionFailedEventSchema,
    BillingSubscriptionStartedEventSchema,
    EVENT_TYPES,
    InvalidEventError,
    MembersExportCompletedEventSchema,
    ReservationCancelledEventSchema,
    ReservationCreatedEventSchema,
    ReservationPromotedEventSchema,
    ReservationReminderEventSchema,
    ReservationWaitlistedEventSchema,
    parseEvent,
} from '../src/events.js';

import type { z } from 'zod';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Canonical UUID v4 values reused across events. */
const EVENT_ID = 'a1b2c3d4-5678-4abc-89ef-1234567890ab';
const STUDIO_ID = 'b2c3d4e5-6789-4bcd-9aef-234567890abc';
const USER_ID = 'c3d4e5f6-789a-4cde-abef-34567890abcd';
const CLASS_ID = 'd4e5f6a7-89ab-4def-bcef-4567890abcde';
const RESERVATION_ID = 'e5f6a7b8-9abc-4ef0-bfef-567890abcdef';
const EXPORT_JOB_ID = 'f6a7b8c9-abcd-4f01-aef0-67890abcdef0';

/** Valid UTC timestamp as emitted by `Date#toISOString()`. */
const NOW = '2025-01-15T10:00:00.000Z';

function baseEnvelope<T extends string>(type: T): {
    id: string;
    type: T;
    occurredAt: string;
    studioId: string;
} {
    return { id: EVENT_ID, type, occurredAt: NOW, studioId: STUDIO_ID };
}

/**
 * Run `schema.safeParse(input)`, assert it failed and return the
 * typed issue array so individual tests stay readable.
 */
function expectFailure<S extends z.ZodType>(
    schema: S,
    input: unknown,
): ReadonlyArray<z.core.$ZodIssue> {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) {
        throw new Error('safeParse unexpectedly succeeded');
    }
    return result.error.issues;
}

/* ================================================================== */
/*  Per-event happy paths                                              */
/* ================================================================== */

describe('AthlyaEventSchema — happy paths', () => {
    it('parses reservation.created', () => {
        const event = {
            ...baseEnvelope('reservation.created'),
            payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
        };
        const parsed = AthlyaEventSchema.parse(event);
        // Discriminator narrows the arm: payload.position would not exist here.
        expect(parsed.type).toBe('reservation.created');
        if (parsed.type === 'reservation.created') {
            expect(parsed.payload.reservationId).toBe(RESERVATION_ID);
        }
    });

    it('parses reservation.waitlisted with a positive position', () => {
        const event = {
            ...baseEnvelope('reservation.waitlisted'),
            payload: {
                reservationId: RESERVATION_ID,
                classId: CLASS_ID,
                userId: USER_ID,
                position: 3,
            },
        };
        const parsed = ReservationWaitlistedEventSchema.parse(event);
        expect(parsed.payload.position).toBe(3);
    });

    it('parses reservation.cancelled', () => {
        const event = {
            ...baseEnvelope('reservation.cancelled'),
            payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
        };
        expect(ReservationCancelledEventSchema.parse(event).type).toBe('reservation.cancelled');
    });

    it('parses reservation.promoted', () => {
        const event = {
            ...baseEnvelope('reservation.promoted'),
            payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
        };
        expect(ReservationPromotedEventSchema.parse(event).type).toBe('reservation.promoted');
    });

    it('parses reservation.reminder with startsAt', () => {
        const event = {
            ...baseEnvelope('reservation.reminder'),
            payload: {
                reservationId: RESERVATION_ID,
                classId: CLASS_ID,
                userId: USER_ID,
                startsAt: '2025-01-15T11:00:00.000Z',
            },
        };
        expect(ReservationReminderEventSchema.parse(event).payload.startsAt).toBe(
            '2025-01-15T11:00:00.000Z',
        );
    });

    it('parses auth.user.registered without studioId (platform-wide event)', () => {
        // studioId is optional — `auth.user.registered` fires before
        // a studio membership exists.
        const event = {
            id: EVENT_ID,
            type: 'auth.user.registered' as const,
            occurredAt: NOW,
            payload: { userId: USER_ID },
        };
        expect(AuthUserRegisteredEventSchema.parse(event).payload.userId).toBe(
            USER_ID,
        );
    });

    it('rejects auth.user.registered with an `email` field (S5-005 minimisation)', () => {
        // Sprint-2 SP2.2 — the `email` field was removed from the
        // payload. The schema is `.strict()` so any rogue producer
        // that still emits `email` is rejected by Zod (defence in
        // depth: a stale build deployed before the bus consumers
        // upgraded would surface a parse error rather than letting
        // the field land on the outbox row).
        const event = {
            id: EVENT_ID,
            type: 'auth.user.registered' as const,
            occurredAt: NOW,
            payload: { userId: USER_ID, email: 'member@example.com' },
        };
        expect(AuthUserRegisteredEventSchema.safeParse(event).success).toBe(false);
    });

    it('parses auth.user.deleted', () => {
        const event = {
            ...baseEnvelope('auth.user.deleted'),
            payload: { userId: USER_ID },
        };
        expect(AuthUserDeletedEventSchema.parse(event).type).toBe('auth.user.deleted');
    });

    it('parses billing.subscription.started', () => {
        const event = {
            ...baseEnvelope('billing.subscription.started'),
            payload: {
                userId: USER_ID,
                subscriptionId: 'sub_123',
                plan: 'monthly-basic',
                startsAt: NOW,
            },
        };
        expect(BillingSubscriptionStartedEventSchema.parse(event).payload.plan).toBe(
            'monthly-basic',
        );
    });

    it('parses billing.subscription.failed', () => {
        const event = {
            ...baseEnvelope('billing.subscription.failed'),
            payload: {
                userId: USER_ID,
                subscriptionId: 'sub_123',
                reason: 'card_declined',
            },
        };
        expect(BillingSubscriptionFailedEventSchema.parse(event).payload.reason).toBe(
            'card_declined',
        );
    });

    it('parses members.export.completed with an HTTPS download URL', () => {
        const event = {
            ...baseEnvelope('members.export.completed'),
            payload: {
                userId: USER_ID,
                exportJobId: EXPORT_JOB_ID,
                downloadUrl: 'https://exports.athlya.app/j/abc.zip',
                expiresAt: '2025-01-16T10:00:00.000Z',
            },
        };
        expect(MembersExportCompletedEventSchema.parse(event).payload.downloadUrl).toMatch(
            /^https:\/\//u,
        );
    });
});

/* ================================================================== */
/*  Discriminator                                                      */
/* ================================================================== */

describe('AthlyaEventSchema — discriminator', () => {
    it('rejects an unknown type with an invalid_union issue', () => {
        const issues = expectFailure(AthlyaEventSchema, {
            ...baseEnvelope('unknown.bogus' as 'reservation.created'),
            payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
        });
        // The discriminator emits `invalid_union` (or `invalid_value`
        // depending on Zod's internals) on the `type` path.
        const onType = issues.filter((i) => i.path.map(String).join('.') === 'type');
        expect(onType.length).toBeGreaterThan(0);
    });

    it('rejects a missing type field', () => {
        const issues = expectFailure(AthlyaEventSchema, {
            id: EVENT_ID,
            occurredAt: NOW,
            payload: {},
        });
        expect(
            issues.some((i) => i.path.map(String).join('.').startsWith('type')),
        ).toBe(true);
    });

    it('exposes every declared type in EVENT_TYPES', () => {
        expect(new Set(EVENT_TYPES)).toEqual(
            new Set([
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
            ]),
        );
    });
});

/* ================================================================== */
/*  Envelope rules                                                     */
/* ================================================================== */

describe('AthlyaEventSchema — envelope rules', () => {
    const validReservationCreated = {
        ...baseEnvelope('reservation.created'),
        payload: { reservationId: RESERVATION_ID, classId: CLASS_ID, userId: USER_ID },
    };

    it('accepts occurredAt with a Z UTC offset', () => {
        expect(
            ReservationCreatedEventSchema.safeParse({
                ...validReservationCreated,
                occurredAt: '2025-01-15T10:00:00Z',
            }).success,
        ).toBe(true);
    });

    it('accepts occurredAt with a numeric UTC offset', () => {
        expect(
            ReservationCreatedEventSchema.safeParse({
                ...validReservationCreated,
                occurredAt: '2025-01-15T10:00:00+01:00',
            }).success,
        ).toBe(true);
    });

    it('rejects a plain-date occurredAt (no time, no zone)', () => {
        const issues = expectFailure(ReservationCreatedEventSchema, {
            ...validReservationCreated,
            occurredAt: '2025-01-15',
        });
        expect(issues.some((i) => i.path.map(String).join('.') === 'occurredAt')).toBe(true);
    });

    it('rejects a datetime without any UTC offset', () => {
        const issues = expectFailure(ReservationCreatedEventSchema, {
            ...validReservationCreated,
            occurredAt: '2025-01-15T10:00:00',
        });
        expect(issues.some((i) => i.path.map(String).join('.') === 'occurredAt')).toBe(true);
    });

    it('rejects a non-UUID event id', () => {
        const issues = expectFailure(ReservationCreatedEventSchema, {
            ...validReservationCreated,
            id: 'not-a-uuid',
        });
        expect(issues.some((i) => i.path.map(String).join('.') === 'id')).toBe(true);
    });

    it('rejects unknown top-level fields (strict envelope)', () => {
        const issues = expectFailure(ReservationCreatedEventSchema, {
            ...validReservationCreated,
            extra: 'nope',
        });
        expect(issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    });
});

/* ================================================================== */
/*  parseEvent + InvalidEventError                                     */
/* ================================================================== */

describe('parseEvent', () => {
    it('returns the typed event on success', () => {
        const raw = {
            ...baseEnvelope('auth.user.deleted'),
            payload: { userId: USER_ID },
        };
        const event = parseEvent(raw);
        expect(event.type).toBe('auth.user.deleted');
    });

    it('throws InvalidEventError on a malformed payload with a path', () => {
        const raw = {
            ...baseEnvelope('reservation.waitlisted'),
            payload: {
                reservationId: RESERVATION_ID,
                classId: CLASS_ID,
                userId: USER_ID,
                position: -1, // must be positive
            },
        };
        let thrown: unknown = null;
        try {
            parseEvent(raw);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(InvalidEventError);
        const error = thrown as InvalidEventError;
        expect(error.issues.length).toBeGreaterThan(0);
        expect(error.issues.some((i) => i.path === 'payload.position')).toBe(true);
    });

    it('throws InvalidEventError on a completely unknown shape', () => {
        const thrown = ((): unknown => {
            try {
                parseEvent({ foo: 'bar' });
                return null;
            } catch (err) {
                return err;
            }
        })();
        expect(thrown).toBeInstanceOf(InvalidEventError);
    });

    it('InvalidEventError carries a readable message including the first path', () => {
        let thrown: unknown = null;
        try {
            parseEvent({
                ...baseEnvelope('reservation.created'),
                payload: { reservationId: 'not-a-uuid', classId: CLASS_ID, userId: USER_ID },
            });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(InvalidEventError);
        expect((thrown as Error).message).toMatch(/payload\.reservationId/u);
    });
});

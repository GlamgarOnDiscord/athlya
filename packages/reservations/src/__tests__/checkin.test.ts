/**
 * Unit tests for `@athlya/reservations/checkin`.
 *
 * Covers the QR check-in use case added in task 6.7:
 *
 *   - Happy path: valid QR inside a freshly-minted reservation → the
 *     reservation is stamped and returned (Req 11.6).
 *   - QR failure propagation: every `QRVerifyFailReason` surfaces
 *     verbatim in `result.code` without touching the repo (Req 11.3).
 *     We cover `invalid_signature`, `token_expired`, `replay` and
 *     `wrong_studio` per the task description.
 *   - `no_reservation`: repo returns `null` → short-circuit with the
 *     matching code, no `markCheckedIn` call.
 *   - `already_checked_in`: repo returns a reservation whose
 *     `checkedInAt` is already populated → surface the code and the
 *     existing row; no stamping.
 *   - `outside_window`: repo returns a confirmed reservation whose
 *     class `startsAt` is 45 minutes in the future → service rejects
 *     it even though the repo let it through.
 *
 * The QR verifier and reservation repo are hand-rolled `vi.fn()`
 * doubles so the suite never pulls in `jose`, `@upstash/redis`,
 * Drizzle or Postgres. Matches the style used by `update.test.ts` and
 * `list.test.ts` in this package.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
    CHECKIN_WINDOW_HALF_MS,
    checkIn,
    type CheckInInput,
    type CheckinReservationRepo,
    type QRVerifier,
    type QRVerifyFailReason,
    type QRVerifySuccess,
} from '../checkin.js';

import type { ReservationRow } from '@athlya/db/schema';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c800';
const STUDIO_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ac';
const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const RESERVATION_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c810';
const JTI = 'b3f0e8c2-0000-4000-8000-000000000001';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.e30.sig'; // opaque — verifier is stubbed

/**
 * Frozen wall-clock (Unix ms). `new Date(FROZEN_NOW).toISOString()` is
 * `2026-02-03T06:30:00.000Z` — picked so every window arithmetic in
 * the tests reads nicely.
 */
const FROZEN_NOW = Date.parse('2026-02-03T06:30:00.000Z');

/**
 * Canonical not-yet-consumed confirmed reservation whose class starts
 * exactly at `FROZEN_NOW`. Tests that need a different `classStartsAt`
 * shift the candidate via the {@link makeCandidate} helper.
 */
const BASE_RESERVATION: ReservationRow = {
    id: RESERVATION_ID,
    classId: CLASS_ID,
    userId: USER_ID,
    status: 'confirmed',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    cancelledAt: null,
    checkedInAt: null,
};

const SUCCESS_VERIFY: QRVerifySuccess = {
    ok: true,
    userId: USER_ID,
    studioId: STUDIO_ID,
    jti: JTI,
};

function makeCandidate(
    overrides: {
        reservation?: Partial<ReservationRow>;
        classStartsAt?: Date;
    } = {},
): { reservation: ReservationRow; classStartsAt: Date } {
    return {
        reservation: { ...BASE_RESERVATION, ...overrides.reservation },
        classStartsAt:
            overrides.classStartsAt ?? new Date(FROZEN_NOW),
    };
}

/**
 * Build a fresh set of `vi.fn()` doubles for the verifier and repo.
 * Returning the mocks individually lets each test assert on call
 * history and argument shape without reaching into `deps`.
 */
function buildDeps(): {
    verify: Mock<QRVerifier['verify']>;
    findConfirmedForCheckin: Mock<CheckinReservationRepo['findConfirmedForCheckin']>;
    markCheckedIn: Mock<CheckinReservationRepo['markCheckedIn']>;
    base: Omit<CheckInInput, 'token' | 'studioId'>;
} {
    const verify = vi.fn<QRVerifier['verify']>();
    const findConfirmedForCheckin =
        vi.fn<CheckinReservationRepo['findConfirmedForCheckin']>();
    const markCheckedIn = vi.fn<CheckinReservationRepo['markCheckedIn']>();

    return {
        verify,
        findConfirmedForCheckin,
        markCheckedIn,
        base: {
            qrVerifier: { verify },
            repo: { findConfirmedForCheckin, markCheckedIn },
            clock: () => FROZEN_NOW,
        },
    };
}

/* ------------------------------------------------------------------ */
/*  Happy path — Requirement 11.6                                      */
/* ------------------------------------------------------------------ */

describe('checkIn — happy path', () => {
    it('verifies the token, stamps checked_in_at, and returns the updated row', async () => {
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);
        findConfirmedForCheckin.mockResolvedValueOnce(makeCandidate());

        const stamped: ReservationRow = {
            ...BASE_RESERVATION,
            checkedInAt: new Date(FROZEN_NOW),
        };
        markCheckedIn.mockResolvedValueOnce(stamped);

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result).toEqual({ code: 'ok', reservation: stamped });

        // The verifier is called with the raw token and the expected
        // studio — exactly the shape task 6.7 requires.
        expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN, STUDIO_ID);

        // The repo's window search is the strict 30-minute band.
        expect(findConfirmedForCheckin).toHaveBeenCalledExactlyOnceWith(
            USER_ID,
            STUDIO_ID,
            {
                start: new Date(FROZEN_NOW - CHECKIN_WINDOW_HALF_MS),
                end: new Date(FROZEN_NOW + CHECKIN_WINDOW_HALF_MS),
            },
        );

        // And the stamp is issued with the exact `now` used for the
        // window, so log timestamps line up.
        expect(markCheckedIn).toHaveBeenCalledExactlyOnceWith(
            RESERVATION_ID,
            new Date(FROZEN_NOW),
        );
    });

    it('accepts a reservation whose class starts exactly at the +30 min boundary', async () => {
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);
        findConfirmedForCheckin.mockResolvedValueOnce(
            makeCandidate({
                classStartsAt: new Date(
                    FROZEN_NOW + CHECKIN_WINDOW_HALF_MS,
                ),
            }),
        );
        markCheckedIn.mockResolvedValueOnce({
            ...BASE_RESERVATION,
            checkedInAt: new Date(FROZEN_NOW),
        });

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result.code).toBe('ok');
        // Boundary is inclusive — the stamp must have happened.
        expect(markCheckedIn).toHaveBeenCalledOnce();
    });
});

/* ------------------------------------------------------------------ */
/*  QR verification failures — Requirement 11.3                        */
/* ------------------------------------------------------------------ */

describe('checkIn — QR verification failures propagate verbatim', () => {
    // Table-driven assertion: each QR failure reason from the
    // verifier must surface in `result.code` unchanged, and the
    // service MUST NOT touch the repo.
    const REASONS: readonly QRVerifyFailReason[] = [
        'invalid_signature',
        'token_expired',
        'replay',
        'wrong_studio',
    ];

    for (const reason of REASONS) {
        it(`surfaces ${reason} and never calls the repo`, async () => {
            const {
                verify,
                findConfirmedForCheckin,
                markCheckedIn,
                base,
            } = buildDeps();

            verify.mockResolvedValueOnce({ ok: false, reason });

            const result = await checkIn({
                ...base,
                token: TOKEN,
                studioId: STUDIO_ID,
            });

            expect(result).toEqual({ code: reason });
            expect(verify).toHaveBeenCalledExactlyOnceWith(TOKEN, STUDIO_ID);
            expect(findConfirmedForCheckin).not.toHaveBeenCalled();
            expect(markCheckedIn).not.toHaveBeenCalled();
        });
    }
});

/* ------------------------------------------------------------------ */
/*  no_reservation                                                     */
/* ------------------------------------------------------------------ */

describe('checkIn — no_reservation', () => {
    it('returns no_reservation when the repo has nothing to hand out', async () => {
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);
        findConfirmedForCheckin.mockResolvedValueOnce(null);

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result).toEqual({ code: 'no_reservation' });
        expect(findConfirmedForCheckin).toHaveBeenCalledOnce();
        // Nothing to stamp when there's no candidate.
        expect(markCheckedIn).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  already_checked_in                                                 */
/* ------------------------------------------------------------------ */

describe('checkIn — already_checked_in', () => {
    it('returns already_checked_in without re-stamping when checkedInAt is set', async () => {
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);

        const previouslyStamped = new Date(FROZEN_NOW - 5 * 60_000);
        const consumed: ReservationRow = {
            ...BASE_RESERVATION,
            checkedInAt: previouslyStamped,
        };
        findConfirmedForCheckin.mockResolvedValueOnce(
            makeCandidate({ reservation: consumed }),
        );

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result).toEqual({
            code: 'already_checked_in',
            reservation: consumed,
        });
        // Critically: we never re-stamp an already-consumed reservation.
        expect(markCheckedIn).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  outside_window                                                     */
/* ------------------------------------------------------------------ */

describe('checkIn — outside_window', () => {
    it('rejects a reservation whose class starts 45 minutes in the future', async () => {
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);
        // 45 min > CHECKIN_WINDOW_HALF_MS (30 min), so the strict
        // service-side window filter must reject.
        const futureStart = new Date(FROZEN_NOW + 45 * 60_000);
        const candidate = makeCandidate({
            classStartsAt: futureStart,
        });
        findConfirmedForCheckin.mockResolvedValueOnce(candidate);

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result).toEqual({
            code: 'outside_window',
            reservation: candidate.reservation,
        });
        expect(markCheckedIn).not.toHaveBeenCalled();
    });

    it('rejects a reservation whose class started 45 minutes ago', async () => {
        // Symmetric case: too far in the *past*. Defensive test — a
        // repo that over-returned a fully-finished class shouldn't
        // let it check in.
        const { verify, findConfirmedForCheckin, markCheckedIn, base } =
            buildDeps();

        verify.mockResolvedValueOnce(SUCCESS_VERIFY);
        const pastStart = new Date(FROZEN_NOW - 45 * 60_000);
        const candidate = makeCandidate({
            classStartsAt: pastStart,
        });
        findConfirmedForCheckin.mockResolvedValueOnce(candidate);

        const result = await checkIn({
            ...base,
            token: TOKEN,
            studioId: STUDIO_ID,
        });

        expect(result.code).toBe('outside_window');
        expect(markCheckedIn).not.toHaveBeenCalled();
    });
});

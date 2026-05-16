/**
 * Reservation state-machine guard.
 *
 * Encodes the legal transitions between the four reservation statuses
 * (`confirmed`, `waitlist`, `cancelled`, `no_show`) exactly as specified
 * in Requirement 10:
 *
 *   - 10.1 — only `confirmed → cancelled`, `confirmed → no_show`,
 *     `waitlist → confirmed`, `waitlist → cancelled` are permitted.
 *   - 10.2 — a "same-state" transition (e.g. `confirmed → confirmed`)
 *     is treated as a no-op and accepted.
 *   - 10.3 — any other transition is rejected with the
 *     `invalid_transition` error code.
 *   - 10.4 — `cancelled` is a terminal state: no transition out of it
 *     (other than the 10.2 no-op) is ever allowed — in particular
 *     `cancelled → confirmed` must stay forbidden.
 *   - 10.5 — members may cancel their own reservation from either
 *     `confirmed` or `waitlist`; both edges are listed in
 *     {@link LEGAL_TRANSITIONS} and therefore accepted here.
 *
 * This module is deliberately pure and has **no** database or event-bus
 * dependency: every mutation helper in the Reservations service is
 * expected to call {@link assertCanTransition} before issuing the
 * `UPDATE`, and the central `canTransition` predicate is the single
 * source of truth used both by production code and by the P3
 * state-machine monotonicity property test (task 6.10).
 */

/**
 * Union of the four labels the reservations table's `status` column can
 * hold. Re-declared locally (rather than imported from
 * `@athlya/shared/schemas/primitives`) so this module stays free of any
 * runtime dependency on Zod; the values are identical to
 * `ReservationStatusSchema` in `@athlya/shared`.
 *
 * Related requirements: 10.1.
 */
export type ReservationStatus = 'confirmed' | 'waitlist' | 'cancelled' | 'no_show';

/**
 * Closed set of non-identity legal edges in the reservation state
 * machine. The four entries correspond one-to-one to the transitions
 * listed in Requirement 10.1 and in `design.md` §"State machine".
 *
 * Declared as a `readonly` tuple of `readonly` pairs so TypeScript
 * preserves the literal element types and downstream code cannot
 * mutate the table at runtime (e.g. push a new edge like
 * `cancelled → confirmed`, which would silently break Requirement 10.4).
 */
export const LEGAL_TRANSITIONS: ReadonlyArray<readonly [ReservationStatus, ReservationStatus]> = [
    ['confirmed', 'cancelled'],
    ['confirmed', 'no_show'],
    ['waitlist', 'confirmed'],
    ['waitlist', 'cancelled'],
] as const;

/**
 * Pure predicate answering "is it legal to move a reservation from
 * `from` to `to`?".
 *
 * Two accept paths:
 *   1. `from === to` — idempotent no-op per Requirement 10.2. Returning
 *      `true` here lets the calling API endpoint short-circuit with
 *      HTTP 200 without touching the database.
 *   2. `(from, to)` appears in {@link LEGAL_TRANSITIONS} — one of the
 *      four explicitly allowed edges per Requirement 10.1.
 *
 * Any other pair returns `false`, which callers translate into a
 * 422 `invalid_transition` response (Requirement 10.3). Crucially,
 * `cancelled → confirmed` is not in the table, so this predicate
 * enforces Requirement 10.4.
 */
export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
    if (from === to) return true;
    for (const [a, b] of LEGAL_TRANSITIONS) {
        if (a === from && b === to) return true;
    }
    return false;
}

/**
 * Error thrown by {@link assertCanTransition} when the requested
 * transition is rejected by {@link canTransition}.
 *
 * The `code` field carries the stable machine-readable identifier
 * surfaced as the `type`/`title` slug in the RFC 7807 Problem Details
 * response (Requirement 10.3, 14.6). `from` and `to` are preserved so
 * the API layer can include them in the response payload for client
 * debugging.
 */
export class InvalidTransitionError extends Error {
    /**
     * Stable machine-readable code. Matches the error code defined by
     * Requirement 10.3 and used by the API Gateway to build the
     * Problem Details envelope.
     */
    public readonly code: 'invalid_transition' = 'invalid_transition' as const;
    public readonly from: ReservationStatus;
    public readonly to: ReservationStatus;

    public constructor(from: ReservationStatus, to: ReservationStatus) {
        super(`Illegal reservation transition: ${from} → ${to}`);
        this.name = 'InvalidTransitionError';
        this.from = from;
        this.to = to;
    }
}

/**
 * Imperative companion to {@link canTransition}. Returns `void` on
 * success and throws {@link InvalidTransitionError} on failure, so
 * callers can put it at the top of a mutation handler and rely on
 * normal exception flow to abort the write.
 *
 * ```ts
 * assertCanTransition(reservation.status, nextStatus);
 * await db.update(reservations).set({ status: nextStatus }).where(...);
 * ```
 */
export function assertCanTransition(from: ReservationStatus, to: ReservationStatus): void {
    if (!canTransition(from, to)) {
        throw new InvalidTransitionError(from, to);
    }
}

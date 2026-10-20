/**
 * Unit tests for the reservation state-machine guard.
 *
 * These tests enumerate every one of the 16 ordered `(from, to)` pairs
 * over the four reservation statuses and assert the predicate matches
 * a hand-coded truth table derived directly from Requirement 10:
 *
 *   - 10.1 — only four non-identity edges are legal.
 *   - 10.2 — same-state transitions are always accepted as a no-op.
 *   - 10.3 — `assertCanTransition` throws `invalid_transition`.
 *   - 10.4 — `cancelled → confirmed` must stay forbidden.
 *   - 10.5 — members can cancel from `confirmed` or `waitlist`
 *     (both edges land in {@link LEGAL_TRANSITIONS}).
 *
 * The truth table is hand-coded (not derived from
 * {@link LEGAL_TRANSITIONS}) on purpose so the test would catch a
 * regression where someone accidentally widens the legal set — a bug
 * that would sail through if the test merely iterated the same array
 * the implementation uses.
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidTransitionError,
  LEGAL_TRANSITIONS,
  assertCanTransition,
  canTransition,
  type ReservationStatus,
} from '../state-machine.js';

/**
 * All five statuses (the four of Requirement 10 and the `pending` hold)
 * in declaration order. Kept local to the test so it
 * cannot accidentally be mutated by a future refactor of the source
 * module.
 */
const STATUSES: readonly ReservationStatus[] = [
  'confirmed',
  'waitlist',
  'cancelled',
  'no_show',
  'pending',
] as const;

/**
 * Hand-coded expected truth table for `canTransition(from, to)`. Rows
 * are `from`, columns are `to`, in the same order as {@link STATUSES}.
 * The diagonal is `true` (Req 10.2 no-op). Off-diagonal `true` cells
 * correspond exactly to the six edges in {@link LEGAL_TRANSITIONS}.
 */
const EXPECTED: Readonly<Record<ReservationStatus, Readonly<Record<ReservationStatus, boolean>>>> =
  {
    confirmed: {
      confirmed: true,
      waitlist: false,
      cancelled: true,
      no_show: true,
      pending: false,
    },
    waitlist: {
      confirmed: true,
      waitlist: true,
      cancelled: true,
      no_show: false,
      pending: false,
    },
    cancelled: {
      confirmed: false,
      waitlist: false,
      cancelled: true,
      no_show: false,
      pending: false,
    },
    no_show: {
      confirmed: false,
      waitlist: false,
      cancelled: false,
      no_show: true,
      pending: false,
    },
    pending: {
      confirmed: true,
      waitlist: false,
      cancelled: true,
      no_show: false,
      pending: true,
    },
  };

describe('canTransition', () => {
  it('matches the hand-coded truth table for all 25 ordered pairs (Req 10.1, 10.2)', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = EXPECTED[from][to];
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  it('returns true for every x → x no-op transition (Req 10.2)', () => {
    for (const s of STATUSES) {
      expect(canTransition(s, s)).toBe(true);
    }
  });

  it('returns false for cancelled → confirmed (Req 10.4)', () => {
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
  });

  it('returns false for every transition out of cancelled except the no-op (Req 10.4)', () => {
    for (const to of STATUSES) {
      const expected = to === 'cancelled';
      expect(canTransition('cancelled', to)).toBe(expected);
    }
  });

  it('accepts every edge enumerated in LEGAL_TRANSITIONS (Req 10.1, 10.5)', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('contains exactly the four edges of Req 10.1 and the two hold exits', () => {
    // Defensive: if someone adds or removes an edge in the source
    // file without updating the requirement, this fails loudly.
    expect(LEGAL_TRANSITIONS).toHaveLength(6);
    const serialised = LEGAL_TRANSITIONS.map(([a, b]) => `${a}->${b}`).sort();
    expect(serialised).toStrictEqual(
      [
        'confirmed->cancelled',
        'confirmed->no_show',
        'waitlist->cancelled',
        'waitlist->confirmed',
        'pending->cancelled',
        'pending->confirmed',
      ].sort(),
    );
  });
});

describe('assertCanTransition', () => {
  it('returns void on every legal transition (non-identity)', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(() => {
        assertCanTransition(from, to);
      }).not.toThrow();
    }
  });

  it('returns void on every same-state no-op (Req 10.2)', () => {
    for (const s of STATUSES) {
      expect(() => {
        assertCanTransition(s, s);
      }).not.toThrow();
    }
  });

  it('throws InvalidTransitionError with code "invalid_transition" on cancelled → confirmed (Req 10.3, 10.4)', () => {
    let caught: unknown;
    try {
      assertCanTransition('cancelled', 'confirmed');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof InvalidTransitionError) {
      expect(caught.code).toBe('invalid_transition');
      expect(caught.from).toBe('cancelled');
      expect(caught.to).toBe('confirmed');
      expect(caught.name).toBe('InvalidTransitionError');
      expect(caught.message).toContain('cancelled');
      expect(caught.message).toContain('confirmed');
    }
  });

  it('throws InvalidTransitionError for every illegal ordered pair (Req 10.3)', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (EXPECTED[from][to]) continue;
        let caught: unknown;
        try {
          assertCanTransition(from, to);
        } catch (err) {
          caught = err;
        }
        expect(caught, `expected throw on ${from} -> ${to}`).toBeInstanceOf(InvalidTransitionError);
        if (caught instanceof InvalidTransitionError) {
          expect(caught.code).toBe('invalid_transition');
          expect(caught.from).toBe(from);
          expect(caught.to).toBe(to);
        }
      }
    }
  });
});

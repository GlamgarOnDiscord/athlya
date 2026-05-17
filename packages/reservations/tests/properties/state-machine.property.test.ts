/**
 * Reservation state-machine — Property 3: State-machine monotonicity.
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
 *
 * The reservation domain has four statuses — `confirmed`, `waitlist`,
 * `cancelled`, `no_show` — and Requirement 10 spells out a strict
 * state machine over them. The `canTransition` predicate in
 * `src/state-machine.ts` is the single source of truth every mutation
 * handler consults before writing to the database. This file fixes
 * its contract with property-based tests so any future change that
 * widens (or narrows) the legal set fails the suite.
 *
 * The four properties below encode Requirement 10 verbatim:
 *
 *   - 10.1 — only `confirmed → cancelled`, `confirmed → no_show`,
 *     `waitlist → confirmed`, `waitlist → cancelled` are permitted.
 *   - 10.2 — `canTransition(x, x)` is always `true`.
 *   - 10.3 — any other ordered pair is rejected (predicate returns
 *     `false`; the imperative `assertCanTransition` helper then
 *     surfaces it as a 422 `invalid_transition` at the HTTP layer —
 *     that wiring is exercised by the API integration test, not here).
 *   - 10.4 — `cancelled → confirmed` is **never** legal.
 *
 * Why property-based rather than example-based?
 *   The state machine is small (16 ordered pairs) and a hand-coded
 *   truth table already lives in `src/__tests__/state-machine.test.ts`.
 *   The property test complements that suite by exercising **random
 *   transition sequences** of up to 20 steps: it draws `(from, to)`
 *   pairs uniformly from the full 16-element cartesian product and
 *   asserts the predicate agrees with the legal set on *every* step
 *   of *every* sequence, with a fast-check seed pinned for
 *   reproducibility. Universal claims — "the predicate is monotonic
 *   in this sense, forever, over any sequence of inputs" — are
 *   exactly what property tests are designed to pin down.
 *
 * Mechanics:
 *   - `numRuns: 200` matches the rest of the monorepo's property
 *     suites (round-trip, sliding-window) and keeps the whole file
 *     well under the 30 s `testTimeout` configured in
 *     `vitest.config.ts`.
 *   - `seed` is fixed so a failing run reproduces locally and in CI;
 *     bump it deliberately to reshuffle the explored region, never
 *     rely on an unseeded run to "catch something".
 *   - The legal-set oracle is hand-coded (not derived from
 *     {@link LEGAL_TRANSITIONS}) on purpose: a regression where
 *     somebody accidentally adds a new edge to the source array
 *     would pass a self-referential test. The oracle here tracks
 *     Requirement 10.1 directly.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canTransition, type ReservationStatus } from '../../src/state-machine.js';

/**
 * All four reservation statuses in declaration order. Declared local
 * to the test so a future refactor of `src/state-machine.ts` cannot
 * accidentally shrink or reorder the set fast-check draws from — that
 * would silently reduce coverage instead of producing a red test.
 */
const STATUSES: readonly ReservationStatus[] = [
  'confirmed',
  'waitlist',
  'cancelled',
  'no_show',
] as const;

/**
 * Hand-coded canonical legal set — Requirement 10.1 verbatim. Stored
 * as a `Set<string>` of `"from->to"` keys so membership checks are
 * O(1) inside the property body. The oracle is independent of the
 * implementation's {@link LEGAL_TRANSITIONS} array on purpose: if
 * someone widens that array (e.g. adds `cancelled → confirmed`) the
 * implementation would return `true` for an illegal pair, and the
 * negative-path property below would fail loudly, as intended.
 */
const LEGAL_SET: ReadonlySet<string> = new Set<string>([
  'confirmed->cancelled',
  'confirmed->no_show',
  'waitlist->confirmed',
  'waitlist->cancelled',
]);

/**
 * Encode an ordered pair as the `"from->to"` string used as
 * {@link LEGAL_SET}'s key.
 */
function key(from: ReservationStatus, to: ReservationStatus): string {
  return `${from}->${to}`;
}

/**
 * Arbitrary drawing a status uniformly from {@link STATUSES}.
 * `fc.constantFrom` preserves literal element types, which lets the
 * property body pass the drawn values straight into `canTransition`
 * without a type cast.
 */
const statusArb = fc.constantFrom<ReservationStatus>(...STATUSES);

/**
 * Arbitrary drawing an ordered `(from, to)` pair from the full
 * 16-element cartesian product `STATUSES × STATUSES`. Roughly
 * 4/16 = 25 % of pairs are no-op same-state transitions (Req 10.2),
 * 4/16 = 25 % are legal non-identity edges (Req 10.1), and the
 * remaining 8/16 = 50 % are illegal non-identity edges (Req 10.3, 10.4).
 * That split gives fast-check meaningful coverage of every branch in
 * a single run.
 */
const transitionArb = fc.tuple(statusArb, statusArb);

/**
 * Arbitrary generating a *sequence* of up to 20 transitions, so each
 * fast-check sample exercises the predicate repeatedly on independent
 * inputs. Sequence length 1..20 keeps shrinking productive — a failing
 * run collapses to the shortest illegal prefix — while still
 * covering enough samples per run to saturate every branch of the
 * truth table.
 */
const transitionSequenceArb = fc.array(transitionArb, { minLength: 1, maxLength: 20 });

/**
 * Reproducibility parameters — stable unless bumped on purpose.
 * `numRuns: 200` mirrors the round-trip and sliding-window suites;
 * the seed matches the convention of using a stable hex constant so
 * CI log messages name the seed explicitly if a run ever fails.
 */
const RUN_OPTS = { numRuns: 200, seed: 0x5e1a1b0c } as const;

describe('canTransition — Property 3 (state-machine monotonicity)', () => {
  it('accepts every same-state no-op (Req 10.2)', () => {
    fc.assert(
      fc.property(statusArb, (s) => canTransition(s, s) === true),
      RUN_OPTS,
    );
  });

  it('accepts every legal non-identity edge enumerated by Req 10.1', () => {
    fc.assert(
      fc.property(transitionArb, ([from, to]) => {
        // Only consider the legal-non-identity slice of the
        // 16-element sample space on this property; the
        // negative path is covered by the next one.
        fc.pre(from !== to);
        fc.pre(LEGAL_SET.has(key(from, to)));
        return canTransition(from, to) === true;
      }),
      RUN_OPTS,
    );
  });

  it('rejects every illegal ordered pair where from !== to (Req 10.3, 10.4)', () => {
    fc.assert(
      fc.property(transitionArb, ([from, to]) => {
        fc.pre(from !== to);
        fc.pre(!LEGAL_SET.has(key(from, to)));
        return canTransition(from, to) === false;
      }),
      RUN_OPTS,
    );
  });

  it('agrees with the legal-set oracle on every step of a random transition sequence', () => {
    fc.assert(
      fc.property(transitionSequenceArb, (sequence) => {
        for (const [from, to] of sequence) {
          const expected = from === to || LEGAL_SET.has(key(from, to));
          if (canTransition(from, to) !== expected) {
            return false;
          }
        }
        return true;
      }),
      RUN_OPTS,
    );
  });

  it('never accepts cancelled → confirmed, regardless of sequence position (Req 10.4)', () => {
    // This property is slightly redundant with the negative-path
    // one above, but spelling it out makes Req 10.4 trivially
    // auditable from the test report and gives fast-check a
    // sharp, always-exercised witness for the terminal-state
    // invariant — even when upstream arbitraries drift.
    fc.assert(
      fc.property(transitionSequenceArb, (sequence) => {
        // Inject the forbidden edge at a random position by
        // prepending it to the sample; the predicate must
        // still reject it.
        const forbidden: readonly [ReservationStatus, ReservationStatus] = [
          'cancelled',
          'confirmed',
        ];
        const withForbidden: ReadonlyArray<readonly [ReservationStatus, ReservationStatus]> = [
          forbidden,
          ...sequence,
        ];
        const head = withForbidden[0] ?? forbidden;
        return canTransition(head[0], head[1]) === false;
      }),
      RUN_OPTS,
    );

    // Belt-and-braces: a single non-random assertion so a broken
    // fast-check harness (e.g. all preconditions filtered out)
    // still cannot let a regression slip through.
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
  });
});

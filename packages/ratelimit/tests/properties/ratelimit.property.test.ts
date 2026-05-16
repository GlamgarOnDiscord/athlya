/**
 * Sliding-window rate limiter — Property 8: Sliding-Window Exactness.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3**
 *
 * The limiter (`rateLimitSlidingWindow`, `src/sliding-window.ts`) implements
 * the "sliding log" algorithm mandated by design Algorithm 5: for each
 * incoming request it trims Redis sorted-set entries older than
 * `now - windowSec * 1000`, appends the current entry, reads the
 * resulting cardinality, and decides `allow` when that count is at
 * most `limit`. The property below asserts the global invariant that
 * falls out of that implementation — and that Req 15.1 spells out as
 * a user-visible contract:
 *
 *   ∀ query time t in the request stream,
 *     |{ a ∈ AllowedTimestamps : a ∈ (t - windowMs, t] }|  ≤  limit
 *
 * In plain English: no sliding window of size `windowSec` ever contains
 * more than `limit` `allow` decisions, no matter how the request
 * timestamps are distributed. This is the only spec-level statement
 * that cannot be proved by a handful of examples — it has to hold for
 * arbitrary sequences, so a property test is the right tool.
 *
 * A second, tighter property validates Req 15.2: whenever the limiter
 * denies a request, the accompanying `retryAfterSec` hint falls in
 * `[1, windowSec]` — small enough to be useful to clients, clamped so
 * misbehaving Redis data cannot leak out as a nonsense Retry-After.
 *
 * Mechanics:
 *   - Time is fully injected through `FakeRedis.nowMs` (the limiter
 *     reads from `deps.now()`), so there is no reliance on wall-clock.
 *   - Timestamps are drawn from `fc.integer({ min: 0, max: 10_000 })`,
 *     then sorted so the sequence is monotonic non-decreasing. The
 *     range is wider than `LIMIT * 1000` and overlaps several window
 *     lengths, guaranteeing fast-check explores both saturated and
 *     relaxed regions of the state space.
 *   - `numRuns: 200` matches the rest of the property suite and keeps
 *     the whole file well under the 30 s timeout.
 *   - A fixed `seed` makes failures reproducible locally and in CI.
 *     Bump it deliberately if you want a fresh exploration; never
 *     rely on unseeded runs to "catch something".
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { rateLimitSlidingWindow } from '../../src/sliding-window.js';
import { FakeRedis, makeRateLimiterDeps } from '../helpers/fake-redis.js';

/** Fixed parameters for the property run — kept small so a failing run
 *  shrinks to a human-readable counter-example. `LIMIT = 10` and
 *  `WINDOW_SEC = 5` give enough headroom that saturating the window is
 *  non-trivial, but not so much that fast-check has to generate
 *  pathologically long sequences to hit the interesting boundary. */
const LIMIT = 10;
const WINDOW_SEC = 5;
const WINDOW_MS = WINDOW_SEC * 1000;
const KEY = 'rl:property';

/** Reproducibility seed for fast-check — stable unless bumped on
 *  purpose. Matches the numRuns/seed convention used by the round-trip
 *  property suite in `@athlya/shared`. */
const RUN_OPTS = { numRuns: 200, seed: 0x4a1b2c3d } as const;

/**
 * Arbitrary of monotonic non-decreasing timestamp sequences.
 *
 * fast-check generates an unsorted array of millisecond timestamps in
 * `[0, 10_000]`, then we sort it in place. Sorting inside the
 * generator (rather than asserting sortedness as a precondition) keeps
 * every generated value valid, which is what makes shrinking
 * productive — shrinks on a valid input stay valid.
 *
 * Length 1..40: long enough to saturate the window several times over
 * (`LIMIT = 10`, span = 10 s vs window = 5 s), short enough that a
 * failing run shrinks in seconds.
 */
const monotonicTimestampsArb = fc
  .array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 40 })
  .map((arr) => [...arr].sort((a, b) => a - b));

/** Record of a single decision — kept in replay order so we can slice
 *  by timestamp when checking the sliding-window invariant. */
type Record = {
  ts: number;
  kind: 'allow' | 'deny';
  retryAfterSec: number | null;
};

/**
 * Replay a timestamp sequence through the limiter against a fresh
 * `FakeRedis`, returning the full decision log. One replay per property
 * sample, no shared state between samples — that is what keeps each
 * fast-check run independent and the seed reproducible.
 */
async function replay(timestamps: readonly number[]): Promise<Record[]> {
  const fake = new FakeRedis();
  const deps = makeRateLimiterDeps(fake);
  const log: Record[] = [];

  for (const ts of timestamps) {
    fake.nowMs = ts;
    const decision = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
    log.push({
      ts,
      kind: decision.kind,
      retryAfterSec: decision.kind === 'deny' ? decision.retryAfterSec : null,
    });
  }

  return log;
}

describe('rateLimitSlidingWindow — Property 8 (Sliding-Window Exactness)', () => {
  it('never allows more than LIMIT requests in any window of size WINDOW_SEC', async () => {
    await fc.assert(
      fc.asyncProperty(monotonicTimestampsArb, async (timestamps) => {
        const log = await replay(timestamps);
        const allowTimestamps = log.filter((r) => r.kind === 'allow').map((r) => r.ts);

        // For every query time t_i in the replayed sequence,
        // count allow timestamps that fall in (t_i - windowMs, t_i].
        // The semi-open left bound matches Req 15.1 exactly.
        for (const t of timestamps) {
          const windowStart = t - WINDOW_MS;
          const inWindow = allowTimestamps.filter((a) => a > windowStart && a <= t).length;

          if (inWindow > LIMIT) {
            // Fail with enough context to debug the seed.
            return false;
          }
        }
        return true;
      }),
      RUN_OPTS,
    );
  });

  it('always reports retryAfterSec in [1, WINDOW_SEC] when denying', async () => {
    await fc.assert(
      fc.asyncProperty(monotonicTimestampsArb, async (timestamps) => {
        const log = await replay(timestamps);
        const deniesOutOfRange = log.filter(
          (r) =>
            r.kind === 'deny' &&
            (r.retryAfterSec === null || r.retryAfterSec < 1 || r.retryAfterSec > WINDOW_SEC),
        );
        return deniesOutOfRange.length === 0;
      }),
      RUN_OPTS,
    );
  });
});

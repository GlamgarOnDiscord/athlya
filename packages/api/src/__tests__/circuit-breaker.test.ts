/**
 * Unit tests for the per-dependency circuit breaker — task 8.7.
 *
 * Validates Requirement 24.2 at the state-machine level. The suite
 * drives the breaker with an injected `clock` so every transition is
 * deterministic; no `setTimeout`, no real wall time, no flakiness.
 *
 * Test matrix:
 *
 *   1. `closed` stays `closed` under 4 failures; the 5th within the
 *      window trips it to `open`.
 *   2. Failures older than `windowMs` are forgotten (jump the clock
 *      past the window and assert the breaker stays `closed`).
 *   3. `open` short-circuits: `exec` throws {@link CircuitOpenError}
 *      and never invokes `fn`.
 *   4. After `resetTimeoutMs` the breaker becomes `half_open`.
 *   5. Half-open probe succeeds → `closed` and the failure buffer is
 *      cleared; probe fails → `open` and the `resetTimeoutMs` timer
 *      restarts; a concurrent call while the probe is in flight is
 *      rejected with {@link CircuitOpenError}.
 *   6. Success in `closed` state clears the failure buffer (Req 24.2
 *      reads "5 consecutive failures").
 *   7. Property (fast-check, numRuns 100): across arbitrary
 *      interleavings of successes / failures and clock advances, the
 *      wrapped `fn` is never invoked while the breaker is `open`.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';

/** Build a fresh breaker with a user-controlled clock and canonical
 *  Req 24.2 thresholds. `now.value` is advanced directly by the tests
 *  so every transition is deterministic. */
function makeBreaker(
  overrides: Partial<{
    failureThreshold: number;
    windowMs: number;
    resetTimeoutMs: number;
    resetJitterMs: number;
    random: () => number;
  }> = {},
): { breaker: CircuitBreaker; now: { value: number } } {
  const now = { value: 0 };
  const breaker = new CircuitBreaker({
    name: 'test',
    failureThreshold: overrides.failureThreshold ?? 5,
    windowMs: overrides.windowMs ?? 30_000,
    resetTimeoutMs: overrides.resetTimeoutMs ?? 60_000,
    // Default jitter OFF for the deterministic transition tests so the
    // exact-deadline assertions hold. The jitter behaviour (issue #140)
    // has its own dedicated describe block below.
    resetJitterMs: overrides.resetJitterMs ?? 0,
    random: overrides.random ?? ((): number => 0),
    clock: () => now.value,
  });
  return { breaker, now };
}

/** Return a fresh rejected promise with a sentinel error. Every test
 *  uses `new Error('boom')` rather than a richer type so we can
 *  assert `rejects.toThrow('boom')` without getting false positives
 *  from CircuitOpenError (whose message is different). */
const failing = (): Promise<never> => Promise.reject(new Error('boom'));
const succeeding =
  <T>(value: T): (() => Promise<T>) =>
  () =>
    Promise.resolve(value);

describe('CircuitBreaker — state transitions', () => {
  it('stays closed under fewer than `failureThreshold` failures', async () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }

    expect(breaker.state()).toBe('closed');
  });

  it('opens on the Nth consecutive failure within the window', async () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }

    expect(breaker.state()).toBe('open');
  });

  it('forgets failures that fell out of the sliding window', async () => {
    const { breaker, now } = makeBreaker();

    // 4 failures at t=0.
    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('closed');

    // Jump past windowMs — the 4 failures above must be dropped
    // before the breaker evaluates the fresh failure.
    now.value = 30_001;

    // Four more failures at t=30_001 — again one short of the
    // threshold. If the breaker had not pruned, this would be
    // failure #8 and the breaker would already be open.
    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('closed');
  });

  it('open circuit throws CircuitOpenError without invoking fn', async () => {
    const { breaker } = makeBreaker();

    // Trip.
    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('open');

    const fn = vi.fn(succeeding('never'));
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('CircuitOpenError carries the circuit name and the `circuit_open` code', async () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }

    try {
      await breaker.exec(succeeding('never'));
      expect.unreachable('breaker should have thrown CircuitOpenError');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      const typed = err as CircuitOpenError;
      expect(typed.circuitName).toBe('test');
      expect(typed.code).toBe('circuit_open');
    }
  });

  it('transitions to half_open after resetTimeoutMs', async () => {
    const { breaker, now } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('open');

    // Just before the cool-down elapses: still open.
    now.value = 59_999;
    expect(breaker.state()).toBe('open');

    // Exactly at the cool-down boundary: half-open.
    now.value = 60_000;
    expect(breaker.state()).toBe('half_open');
  });

  it('half-open successful probe → closed and clears the failure buffer', async () => {
    const { breaker, now } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    now.value = 60_000;

    const fn = vi.fn(succeeding('hello'));
    await expect(breaker.exec(fn)).resolves.toBe('hello');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.state()).toBe('closed');

    // Buffer cleared: 4 fresh failures (at the same timestamp as
    // the probe) should still leave the breaker closed. If the
    // buffer had survived, the 1 pre-existing failure count + 4
    // new = 5 would already have tripped it — but the probe
    // success resets everything.
    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('closed');
  });

  it('half-open failed probe → open and restarts the reset timer', async () => {
    const { breaker, now } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    now.value = 60_000;
    expect(breaker.state()).toBe('half_open');

    await expect(breaker.exec(failing)).rejects.toThrow('boom');
    expect(breaker.state()).toBe('open');

    // The timer restarts from the probe failure time (60_000), so
    // at 119_999 we are still open, and at 120_000 we re-enter
    // half_open.
    now.value = 119_999;
    expect(breaker.state()).toBe('open');
    now.value = 120_000;
    expect(breaker.state()).toBe('half_open');
  });

  it('rejects a concurrent call while a half-open probe is in flight', async () => {
    const { breaker, now } = makeBreaker();

    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    now.value = 60_000;

    // A probe that never resolves until we explicitly resolve it.
    let resolveProbe: (value: string) => void = () => undefined;
    const probePromise = new Promise<string>((resolve) => {
      resolveProbe = resolve;
    });
    const probeFn = vi.fn(() => probePromise);

    // Kick off the probe. We deliberately do NOT await — the
    // whole point is that another call arrives while this one
    // is still pending.
    const inFlight = breaker.exec(probeFn);

    // Concurrent call while the probe is pending must be refused.
    const concurrent = vi.fn(succeeding('never'));
    await expect(breaker.exec(concurrent)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(concurrent).not.toHaveBeenCalled();

    // Resolve the probe and confirm the primary call settled
    // cleanly.
    resolveProbe('ok');
    await expect(inFlight).resolves.toBe('ok');
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(breaker.state()).toBe('closed');
  });

  it('success in closed state clears the failure buffer', async () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    // One success in between — should clear the 4 failures above.
    await expect(breaker.exec(succeeding('ok'))).resolves.toBe('ok');

    // 4 more failures: still below threshold because the buffer
    // was reset on the success above.
    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('closed');
  });

  it('surfaces the underlying error when a failure trips the breaker', async () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 4; i += 1) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    // The 5th failure both records the trip AND surfaces the
    // underlying error to the caller. The caller must NOT see a
    // generic CircuitOpenError on the call that tripped the
    // breaker — it has to see the real cause of the failure, so
    // the breaker does not mask the downstream error message.
    await expect(breaker.exec(failing)).rejects.toThrow('boom');
    expect(breaker.state()).toBe('open');
  });

  it('manual recordFailure / recordSuccess drive the state machine', () => {
    const { breaker } = makeBreaker();

    for (let i = 0; i < 4; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.state()).toBe('closed');

    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
  });

  it('rejects invalid options', () => {
    expect(() => new CircuitBreaker({ name: 'x', failureThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ name: 'x', windowMs: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ name: 'x', resetTimeoutMs: 0 })).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ */
/*  Half-open jitter (issue #140 / audit R1 — anti-storm)              */
/* ------------------------------------------------------------------ */

describe('CircuitBreaker — half-open jitter', () => {
  it('defaults resetJitterMs to 20% of resetTimeoutMs and delays the probe deadline', () => {
    const now = { value: 0 };
    // random() = 0.5 → jitter = floor(0.5 * 12_000) = 6_000.
    const breaker = new CircuitBreaker({
      name: 'jitter',
      resetTimeoutMs: 60_000,
      random: () => 0.5,
      clock: () => now.value,
    });

    for (let i = 0; i < 5; i += 1) {
      breaker.recordFailure();
    }
    expect(breaker.state()).toBe('open');

    // At the plain deadline the breaker is STILL open (jitter not elapsed).
    now.value = 60_000;
    expect(breaker.state()).toBe('open');
    // Just before reset + jitter: still open.
    now.value = 65_999;
    expect(breaker.state()).toBe('open');
    // At reset + jitter (66_000): half-open.
    now.value = 66_000;
    expect(breaker.state()).toBe('half_open');
  });

  it('de-synchronises two isolates that tripped at the same instant', () => {
    const nowA = { value: 0 };
    const nowB = { value: 0 };
    const breakerA = new CircuitBreaker({
      name: 'dep',
      resetTimeoutMs: 60_000,
      random: () => 0, // jitter 0 → probes at 60_000
      clock: () => nowA.value,
    });
    const breakerB = new CircuitBreaker({
      name: 'dep',
      resetTimeoutMs: 60_000,
      random: () => 0.99, // jitter ~11_880 → probes much later
      clock: () => nowB.value,
    });

    for (let i = 0; i < 5; i += 1) {
      breakerA.recordFailure();
      breakerB.recordFailure();
    }

    nowA.value = 60_000;
    nowB.value = 60_000;
    // Same trip instant, same deadline — but the jitter spreads them:
    // A probes now, B is still open.
    expect(breakerA.state()).toBe('half_open');
    expect(breakerB.state()).toBe('open');
  });

  it('draws a fresh jitter on every trip', () => {
    const now = { value: 0 };
    const randoms = [0, 0.99];
    let i = 0;
    const breaker = new CircuitBreaker({
      name: 'dep',
      resetTimeoutMs: 60_000,
      random: () => randoms[i++ % randoms.length]!,
      clock: () => now.value,
    });

    // First trip: random=0 → jitter 0 → half-open at 60_000.
    for (let k = 0; k < 5; k += 1) breaker.recordFailure();
    now.value = 60_000;
    expect(breaker.state()).toBe('half_open');

    // Failed probe re-opens at t=60_000 and draws random=0.99 →
    // jitter = floor(0.99 * 12_000) = 11_880. Deadline = openedAt
    // (60_000) + reset (60_000) + jitter (11_880) = 131_880.
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    now.value = 131_879;
    expect(breaker.state()).toBe('open'); // 1 ms before reset + jitter
    now.value = 131_880;
    expect(breaker.state()).toBe('half_open');
  });

  it('rejects a negative resetJitterMs', () => {
    expect(() => new CircuitBreaker({ name: 'x', resetJitterMs: -1 })).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ */
/*  Transition observability hook (issue #140 — metrics)              */
/* ------------------------------------------------------------------ */

describe('CircuitBreaker — onTransition hook', () => {
  it('emits closed → open → half_open → closed, jitter on open + matching half_open, 0 on close', () => {
    const now = { value: 0 };
    const events: Array<{ from: string; to: string; at: number; jitterMs: number }> = [];
    // random=0.5 → jitter = floor(0.5 * 12_000) = 6_000.
    const breaker = new CircuitBreaker({
      name: 'redis',
      resetTimeoutMs: 60_000,
      random: () => 0.5,
      clock: () => now.value,
      onTransition: (e) => events.push({ from: e.from, to: e.to, at: e.at, jitterMs: e.jitterMs }),
    });

    for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    now.value = 66_000; // reset (60_000) + jitter (6_000)
    expect(breaker.state()).toBe('half_open');
    breaker.recordSuccess();

    expect(events).toEqual([
      { from: 'closed', to: 'open', at: 0, jitterMs: 6_000 },
      { from: 'open', to: 'half_open', at: 66_000, jitterMs: 6_000 },
      // half_open → closed: no window in flight → 0, NOT the stale 6_000.
      { from: 'half_open', to: 'closed', at: 66_000, jitterMs: 0 },
    ]);
  });

  it('swallows hook exceptions — a logging failure never escalates an outage', () => {
    const breaker = new CircuitBreaker({
      name: 'pg',
      onTransition: () => {
        throw new Error('sink down');
      },
    });
    expect(() => {
      for (let i = 0; i < 5; i += 1) breaker.recordFailure();
    }).not.toThrow();
    expect(breaker.state()).toBe('open');
  });
});

/* ------------------------------------------------------------------ */
/*  Property-based invariant                                           */
/* ------------------------------------------------------------------ */

describe('CircuitBreaker — property: open state short-circuits fn', () => {
  /**
   * Arbitrary interleaving of three operations:
   *
   *   - `success`     : a call that resolves.
   *   - `failure`     : a call that rejects.
   *   - `advance(ms)` : push the injected clock forward.
   *
   * The generated sequence is fed to a fresh breaker, and the
   * driver counts how many calls reach `fn` while the breaker's
   * state is reported as `'open'`. That count must always be zero —
   * the open-state short-circuit is the single most important
   * correctness guarantee of the breaker, and it must hold under
   * any interleaving the generator can produce.
   */
  type Op = { kind: 'success' } | { kind: 'failure' } | { kind: 'advance'; deltaMs: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.constant<Op>({ kind: 'success' }),
    fc.constant<Op>({ kind: 'failure' }),
    fc.integer({ min: 1, max: 70_000 }).map<Op>((deltaMs) => ({ kind: 'advance', deltaMs })),
  );

  it('fn is never called while state() === "open"', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 80 }), async (ops) => {
        const { breaker, now } = makeBreaker();
        let invocationsWhileOpen = 0;

        for (const op of ops) {
          if (op.kind === 'advance') {
            now.value += op.deltaMs;
            continue;
          }

          const stateBefore = breaker.state();
          const fn = (): Promise<string> => {
            if (stateBefore === 'open') {
              invocationsWhileOpen += 1;
            }
            return op.kind === 'success'
              ? Promise.resolve('ok')
              : Promise.reject(new Error('boom'));
          };

          try {
            await breaker.exec(fn);
          } catch {
            // Expected on failure / on CircuitOpenError.
          }
        }

        return invocationsWhileOpen === 0;
      }),
      { numRuns: 100, seed: 0x5fd8 },
    );
  });
});

/* ------------------------------------------------------------------ */
/*  H3 invariant — per-isolate state                                    */
/* ------------------------------------------------------------------ */

describe('isolate independence (H3 invariant)', () => {
  /**
   * Encodes the H3 decision (see the "Semantics under Cloudflare
   * Workers" block in `circuit-breaker.ts`): breaker state is
   * per-isolate. Two `CircuitBreaker` instances — even with the
   * same `name` — must not share any state.
   *
   * A future PR that tries to "fix" the per-isolate drift by
   * introducing a module-scope shared map of breakers keyed by
   * `name` will fail this test, which is exactly the guard the
   * H3 decision calls for.
   */
  it('two breakers for the same name are independent — trip on one does not trip the other', async () => {
    const { breaker: breakerA } = makeBreaker();
    const { breaker: breakerB } = makeBreaker();

    // Trip A with 5 consecutive failures.
    for (let i = 0; i < 5; i++) {
      await expect(breakerA.exec(failing)).rejects.toThrow('boom');
    }
    expect(breakerA.state()).toBe('open');

    // B, in its own isolate, stays closed — proves per-isolate state.
    expect(breakerB.state()).toBe('closed');

    // B can still execute successfully while A is open.
    await expect(breakerB.exec(succeeding('hello'))).resolves.toBe('hello');
    expect(breakerB.state()).toBe('closed');
  });
});

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

import {
    CircuitBreaker,
    CircuitOpenError,
} from '../circuit-breaker.js';

/** Build a fresh breaker with a user-controlled clock and canonical
 *  Req 24.2 thresholds. `now.value` is advanced directly by the tests
 *  so every transition is deterministic. */
function makeBreaker(
    overrides: Partial<{
        failureThreshold: number;
        windowMs: number;
        resetTimeoutMs: number;
    }> = {},
): { breaker: CircuitBreaker; now: { value: number } } {
    const now = { value: 0 };
    const breaker = new CircuitBreaker({
        name: 'test',
        failureThreshold: overrides.failureThreshold ?? 5,
        windowMs: overrides.windowMs ?? 30_000,
        resetTimeoutMs: overrides.resetTimeoutMs ?? 60_000,
        clock: () => now.value,
    });
    return { breaker, now };
}

/** Return a fresh rejected promise with a sentinel error. Every test
 *  uses `new Error('boom')` rather than a richer type so we can
 *  assert `rejects.toThrow('boom')` without getting false positives
 *  from CircuitOpenError (whose message is different). */
const failing = (): Promise<never> => Promise.reject(new Error('boom'));
const succeeding = <T>(value: T): () => Promise<T> => () => Promise.resolve(value);

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
        await expect(breaker.exec(concurrent)).rejects.toBeInstanceOf(
            CircuitOpenError,
        );
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
        expect(
            () => new CircuitBreaker({ name: 'x', failureThreshold: 0 }),
        ).toThrow(RangeError);
        expect(() => new CircuitBreaker({ name: 'x', windowMs: 0 })).toThrow(
            RangeError,
        );
        expect(
            () => new CircuitBreaker({ name: 'x', resetTimeoutMs: 0 }),
        ).toThrow(RangeError);
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
    type Op =
        | { kind: 'success' }
        | { kind: 'failure' }
        | { kind: 'advance'; deltaMs: number };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
        fc.constant<Op>({ kind: 'success' }),
        fc.constant<Op>({ kind: 'failure' }),
        fc
            .integer({ min: 1, max: 70_000 })
            .map<Op>((deltaMs) => ({ kind: 'advance', deltaMs })),
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

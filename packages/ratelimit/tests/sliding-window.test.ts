/**
 * Unit tests for `rateLimitSlidingWindow`.
 *
 * The limiter is unit-tested against an in-memory fake of the Upstash
 * Redis sorted-set API, shared with the property-based suite via
 * `tests/helpers/fake-redis.ts`. The fake implements the five
 * commands the limiter actually uses (`zremrangebyscore`, `zadd`,
 * `zcard`, `expire`, `zrange`) and the `pipeline().exec()`
 * indirection. A full Redis or Upstash integration test belongs to a
 * later integration stage; here we only verify the sequential
 * semantics with a deterministic injected clock.
 *
 * Scenarios covered:
 *   • Fresh key: `limit` requests allowed, the `limit+1`-th denied.
 *   • Sliding: once `windowSec * 1000 + 1` ms have elapsed, the count
 *     resets and the next request is allowed again.
 *   • `retryAfterSec` is always in `[1, windowSec]` when denying.
 *   • Invalid inputs throw synchronously.
 */

import { describe, expect, it } from 'vitest';

import { rateLimitSlidingWindow } from '../src/sliding-window.js';

import { FakeRedis, makeRateLimiterDeps } from './helpers/fake-redis.js';

describe('rateLimitSlidingWindow', () => {
    const KEY = 'rl:test';
    const LIMIT = 3;
    const WINDOW_SEC = 10;

    it('allows up to `limit` requests on a fresh key and denies the (limit+1)-th', async () => {
        const fake = new FakeRedis();
        const deps = makeRateLimiterDeps(fake);
        fake.nowMs = 1_000;

        for (let i = 0; i < LIMIT; i++) {
            const decision = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
            expect(decision.kind).toBe('allow');
            if (decision.kind === 'allow') {
                expect(decision.remaining).toBe(LIMIT - (i + 1));
            }
            fake.nowMs += 1; // advance 1 ms between requests
        }

        const denied = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
        expect(denied.kind).toBe('deny');
        if (denied.kind === 'deny') {
            expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
            expect(denied.retryAfterSec).toBeLessThanOrEqual(WINDOW_SEC);
        }
    });

    it('resets after the window has elapsed and allows new requests', async () => {
        const fake = new FakeRedis();
        const deps = makeRateLimiterDeps(fake);
        fake.nowMs = 0;

        for (let i = 0; i < LIMIT; i++) {
            const d = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
            expect(d.kind).toBe('allow');
        }

        // Immediate follow-up is denied…
        const deniedImmediately = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
        expect(deniedImmediately.kind).toBe('deny');

        // …but after the window fully slides off, we're allowed again.
        fake.nowMs += WINDOW_SEC * 1000 + 1;
        const afterWindow = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
        expect(afterWindow.kind).toBe('allow');
        if (afterWindow.kind === 'allow') {
            // Only the single just-inserted request counts toward the limit.
            expect(afterWindow.remaining).toBe(LIMIT - 1);
        }
    });

    it('returns retryAfterSec in [1, windowSec] when denying', async () => {
        const fake = new FakeRedis();
        const deps = makeRateLimiterDeps(fake);

        // Saturate the window so the next call must deny.
        fake.nowMs = 5_000;
        for (let i = 0; i < LIMIT; i++) {
            await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
            fake.nowMs += 500;
        }

        const denied = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
        expect(denied.kind).toBe('deny');
        if (denied.kind === 'deny') {
            expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
            expect(denied.retryAfterSec).toBeLessThanOrEqual(WINDOW_SEC);
        }
    });

    it('rejects non-positive limit and windowSec synchronously', async () => {
        const fake = new FakeRedis();
        const deps = makeRateLimiterDeps(fake);

        await expect(rateLimitSlidingWindow(deps, KEY, 0, WINDOW_SEC)).rejects.toThrow(RangeError);
        await expect(rateLimitSlidingWindow(deps, KEY, LIMIT, 0)).rejects.toThrow(RangeError);
        await expect(rateLimitSlidingWindow(deps, KEY, -1, WINDOW_SEC)).rejects.toThrow(
            RangeError,
        );
    });

    it('does not collapse two requests arriving on the same millisecond', async () => {
        const fake = new FakeRedis();
        const deps = makeRateLimiterDeps(fake);
        fake.nowMs = 42;

        const a = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);
        const b = await rateLimitSlidingWindow(deps, KEY, LIMIT, WINDOW_SEC);

        expect(a.kind).toBe('allow');
        expect(b.kind).toBe('allow');
        if (a.kind === 'allow' && b.kind === 'allow') {
            expect(a.remaining).toBe(LIMIT - 1);
            expect(b.remaining).toBe(LIMIT - 2);
        }
    });
});

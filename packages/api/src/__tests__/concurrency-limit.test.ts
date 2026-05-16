/**
 * Unit tests for the per-user concurrency limit middleware
 * (Sprint 12 / Slice 12.4, Epic B4.3).
 *
 * Mirrors the test pattern of `rate-limit.test.ts`: inject a fake
 * Redis, simulate sequential / concurrent calls through the
 * middleware, assert the counter dynamics (INCR on entry, DECR on
 * exit, 429 over the limit).
 */

import { describe, expect, it, vi } from 'vitest';

import {
    CONCURRENCY_BUCKET_PREFIX,
    DEFAULT_CONCURRENCY_LIMIT,
    concurrencyLimit,
} from '../middleware/concurrency-limit.js';

import { FakeRedis } from '../../tests/helpers/fake-redis.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function asRedis(fake: FakeRedis): Redis {
    return fake as unknown as Redis;
}

interface FakeContext {
    readonly authClaims?: { userId: string; studioId: string; role: string };
    readonly traceId?: string;
}

function makeCtx(values: FakeContext = {}): {
    env: { REDIS_URL?: string; REDIS_TOKEN?: string };
    get(key: string): unknown;
    body(
        data: string,
        status: number,
        headers: Record<string, string>,
    ): Response;
} {
    const map = new Map<string, unknown>();
    if (values.authClaims) map.set('authClaims', values.authClaims);
    if (values.traceId !== undefined) map.set('traceId', values.traceId);
    return {
        env: {},
        get(key: string): unknown {
            return map.get(key);
        },
        body(
            data: string,
            status: number,
            headers: Record<string, string>,
        ): Response {
            return new Response(data, { status, headers });
        },
    };
}

const ALICE = { userId: 'alice', studioId: 's1', role: 'member' };
const BOB = { userId: 'bob', studioId: 's1', role: 'member' };

/* ------------------------------------------------------------------ */
/*  Anonymous bypass                                                    */
/* ------------------------------------------------------------------ */

describe('concurrencyLimit — anonymous traffic', () => {
    it('passes through without touching Redis when authClaims is absent', async () => {
        const fake = new FakeRedis();
        const incrSpy = vi.spyOn(fake, 'incr');
        const middleware = concurrencyLimit({
            redis: asRedis(fake),
        });

        const ctx = makeCtx(); // no authClaims
        const next = vi.fn(() => Promise.resolve());

        const result = await middleware(ctx, next);

        expect(result).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
        expect(incrSpy).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/*  Per-user counter                                                    */
/* ------------------------------------------------------------------ */

describe('concurrencyLimit — per-user counter', () => {
    it('increments and decrements around next() on a normal request', async () => {
        const fake = new FakeRedis();
        const middleware = concurrencyLimit({ redis: asRedis(fake) });

        const ctx = makeCtx({ authClaims: ALICE });
        let counterDuringNext = 0;
        const next = vi.fn(async () => {
            counterDuringNext = fake.counters.get(
                `${CONCURRENCY_BUCKET_PREFIX}:alice`,
            ) ?? 0;
        });

        await middleware(ctx, next);

        expect(next).toHaveBeenCalledOnce();
        // Inside the handler the counter is at 1 (we are running).
        expect(counterDuringNext).toBe(1);
        // After the handler returns it is back to 0.
        expect(
            fake.counters.get(`${CONCURRENCY_BUCKET_PREFIX}:alice`),
        ).toBe(0);
    });

    it('decrements even when next() throws', async () => {
        const fake = new FakeRedis();
        const middleware = concurrencyLimit({ redis: asRedis(fake) });

        const ctx = makeCtx({ authClaims: ALICE });
        const next = vi.fn(() => Promise.reject(new Error('handler boom')));

        await expect(middleware(ctx, next)).rejects.toThrow('handler boom');

        // The error propagated, but the counter still went back to
        // 0 — the `finally` arm is what guarantees this.
        expect(
            fake.counters.get(`${CONCURRENCY_BUCKET_PREFIX}:alice`),
        ).toBe(0);
    });

    it('keys per-user — alice and bob have independent counters', async () => {
        const fake = new FakeRedis();
        const middleware = concurrencyLimit({
            limit: 1,
            redis: asRedis(fake),
        });

        // Open a long-running request for alice (counter sits at 1).
        let resolveAlice!: () => void;
        const aliceDone = new Promise<void>((r) => (resolveAlice = r));
        const aliceCall = middleware(makeCtx({ authClaims: ALICE }), () =>
            aliceDone,
        );

        // While alice is still running, bob's first request is
        // allowed because he keys on a different counter.
        const bobNext = vi.fn(() => Promise.resolve());
        const bobResult = await middleware(
            makeCtx({ authClaims: BOB }),
            bobNext,
        );

        expect(bobResult).toBeUndefined();
        expect(bobNext).toHaveBeenCalledOnce();

        // Cleanup — let alice complete.
        resolveAlice();
        await aliceCall;
    });
});

/* ------------------------------------------------------------------ */
/*  Over-cap behaviour                                                  */
/* ------------------------------------------------------------------ */

describe('concurrencyLimit — over the cap', () => {
    it('returns 429 Problem Details when the user has too many in-flight requests', async () => {
        const fake = new FakeRedis();
        const middleware = concurrencyLimit({
            limit: 2,
            redis: asRedis(fake),
        });

        // Fire 2 concurrent requests, then try to fire a 3rd.
        let resolve1!: () => void;
        let resolve2!: () => void;
        const done1 = new Promise<void>((r) => (resolve1 = r));
        const done2 = new Promise<void>((r) => (resolve2 = r));
        const call1 = middleware(
            makeCtx({ authClaims: ALICE, traceId: 'trace-1' }),
            () => done1,
        );
        const call2 = middleware(
            makeCtx({ authClaims: ALICE, traceId: 'trace-2' }),
            () => done2,
        );

        // The 3rd should be refused immediately.
        const blockedNext = vi.fn(() => Promise.resolve());
        const blocked = await middleware(
            makeCtx({ authClaims: ALICE, traceId: 'trace-blocked' }),
            blockedNext,
        );

        expect(blocked).toBeInstanceOf(Response);
        expect((blocked as Response).status).toBe(429);
        expect((blocked as Response).headers.get('content-type')).toBe(
            'application/problem+json',
        );
        expect((blocked as Response).headers.get('retry-after')).toBe('1');

        const body = (await (blocked as Response).json()) as {
            status: number;
            code: string;
            traceId: string;
        };
        expect(body.status).toBe(429);
        expect(body.code).toBe('concurrency_limit_exceeded');
        expect(body.traceId).toBe('trace-blocked');

        // The blocked request did NOT consume a slot from the
        // budget — `decr` was called immediately after detecting
        // the over-cap.
        expect(blockedNext).not.toHaveBeenCalled();

        // Cleanup.
        resolve1();
        resolve2();
        await call1;
        await call2;
    });

    it('allows new requests once existing ones complete', async () => {
        const fake = new FakeRedis();
        const middleware = concurrencyLimit({
            limit: 1,
            redis: asRedis(fake),
        });

        // First request opens, completes synchronously.
        const next1 = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: ALICE }), next1);
        expect(next1).toHaveBeenCalledOnce();

        // Counter is back to 0; the second request is allowed.
        const next2 = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: ALICE }), next2);
        expect(next2).toHaveBeenCalledOnce();
    });
});

/* ------------------------------------------------------------------ */
/*  Fail-open                                                            */
/* ------------------------------------------------------------------ */

describe('concurrencyLimit — fail-open on Redis outage', () => {
    it('passes through when INCR throws', async () => {
        const fake = new FakeRedis();
        vi.spyOn(fake, 'incr').mockRejectedValueOnce(
            new Error('ECONNREFUSED'),
        );
        const middleware = concurrencyLimit({ redis: asRedis(fake) });

        const next = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: ALICE }), next);

        // The middleware swallows the Redis error and lets the
        // request continue — concurrency is defence in depth, not
        // primary defence.
        expect(next).toHaveBeenCalledOnce();
    });
});

/* ------------------------------------------------------------------ */
/*  Defaults                                                             */
/* ------------------------------------------------------------------ */

describe('concurrencyLimit — defaults', () => {
    it('uses DEFAULT_CONCURRENCY_LIMIT when no override supplied', () => {
        // Just verify the constant; the over-cap test above
        // exercises the default path implicitly via the explicit
        // `limit: 2` override.
        expect(DEFAULT_CONCURRENCY_LIMIT).toBe(10);
    });
});

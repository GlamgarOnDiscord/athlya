/**
 * Unit tests for the per-studio rate-limit middleware
 * (Sprint 12 / Slice 12.5, Epic B4.4).
 *
 * Mirrors `rate-limit.test.ts` but keys on `studioId` instead of
 * `userId`. The shared `rateLimitSlidingWindow` primitive is the
 * same; we just validate the wiring + key derivation here.
 */

import { describe, expect, it, vi } from 'vitest';

import { FakeRedis } from '../../tests/helpers/fake-redis.js';
import {
    DEFAULT_STUDIO_LIMIT,
    STUDIO_BUCKET_PREFIX,
    studioRateLimit,
} from '../middleware/studio-rate-limit.js';


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

const STUDIO_A = { userId: 'u1', studioId: 'studio-A', role: 'member' };
const STUDIO_B = { userId: 'u1', studioId: 'studio-B', role: 'member' };

/* ------------------------------------------------------------------ */
/*  Anonymous bypass                                                    */
/* ------------------------------------------------------------------ */

describe('studioRateLimit — anonymous bypass', () => {
    it('passes through without touching Redis when authClaims absent', async () => {
        const fake = new FakeRedis();
        const middleware = studioRateLimit({ redis: asRedis(fake) });

        const next = vi.fn(() => Promise.resolve());
        const result = await middleware(makeCtx(), next);

        expect(result).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
        // No bucket created.
        expect(fake.sets.size).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  Per-studio bucket                                                   */
/* ------------------------------------------------------------------ */

describe('studioRateLimit — per-studio bucket', () => {
    it('keys on studioId; studios get independent buckets', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 1000;
        const middleware = studioRateLimit({
            limit: 1,
            windowSec: 60,
            redis: asRedis(fake),
        });

        // Studio A consumes its budget.
        const next = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: STUDIO_A }), next);
        expect(next).toHaveBeenCalledTimes(1);

        // Studio A's second call denies.
        const denied = await middleware(
            makeCtx({ authClaims: STUDIO_A, traceId: 'trace-x' }),
            next,
        );
        expect(denied).toBeInstanceOf(Response);
        expect((denied as Response).status).toBe(429);

        // Studio B has its own bucket — first call still allowed.
        await middleware(makeCtx({ authClaims: STUDIO_B }), next);
        expect(next).toHaveBeenCalledTimes(2);
    });

    it('uses the STUDIO_BUCKET_PREFIX in the Redis key', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 5000;
        const middleware = studioRateLimit({
            limit: 5,
            redis: asRedis(fake),
        });

        const next = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: STUDIO_A }), next);

        const expectedKey = `${STUDIO_BUCKET_PREFIX}:studio-A`;
        expect(fake.sets.has(expectedKey)).toBe(true);
    });
});

/* ------------------------------------------------------------------ */
/*  Deny shape                                                          */
/* ------------------------------------------------------------------ */

describe('studioRateLimit — deny response shape', () => {
    it('returns 429 Problem Details with studio_rate_limit_exceeded code', async () => {
        const fake = new FakeRedis();
        fake.nowMs = 1000;
        const middleware = studioRateLimit({
            limit: 1,
            windowSec: 60,
            redis: asRedis(fake),
        });

        const next = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: STUDIO_A }), next);
        const denied = await middleware(
            makeCtx({ authClaims: STUDIO_A, traceId: 'trace-deny' }),
            next,
        );

        const res = denied as Response;
        expect(res.status).toBe(429);
        expect(res.headers.get('content-type')).toBe(
            'application/problem+json',
        );
        const retryAfter = res.headers.get('retry-after');
        expect(retryAfter).not.toBeNull();
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

        const body = ((await res.json() as any));
        expect(body.status).toBe(429);
        expect(body.code).toBe('studio_rate_limit_exceeded');
        expect(body.title).toBe('Too Many Requests');
        expect(body.traceId).toBe('trace-deny');
    });
});

/* ------------------------------------------------------------------ */
/*  Fail-open                                                            */
/* ------------------------------------------------------------------ */

describe('studioRateLimit — fail-open', () => {
    it('passes through on Redis error', async () => {
        const fake = new FakeRedis();
        // Force an error at the rate-limiter layer by mocking
        // `zadd` to throw.
        vi.spyOn(fake, 'zadd').mockRejectedValueOnce(
            new Error('ECONNREFUSED'),
        );
        const middleware = studioRateLimit({
            limit: 1,
            redis: asRedis(fake),
        });

        const next = vi.fn(() => Promise.resolve());
        await middleware(makeCtx({ authClaims: STUDIO_A }), next);

        expect(next).toHaveBeenCalledOnce();
    });
});

/* ------------------------------------------------------------------ */
/*  Defaults                                                             */
/* ------------------------------------------------------------------ */

describe('studioRateLimit — defaults', () => {
    it('uses DEFAULT_STUDIO_LIMIT when no override supplied', () => {
        expect(DEFAULT_STUDIO_LIMIT).toBe(1000);
    });

    it('rejects invalid limit values at construction time', () => {
        expect(() => studioRateLimit({ limit: 0 })).toThrow(/must be > 0/);
        expect(() => studioRateLimit({ limit: -5 })).toThrow(/must be > 0/);
    });

    it('rejects invalid windowSec values at construction time', () => {
        expect(() => studioRateLimit({ windowSec: 0 })).toThrow(
            /must be > 0/,
        );
    });
});

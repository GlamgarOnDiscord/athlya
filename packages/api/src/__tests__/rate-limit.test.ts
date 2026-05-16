/**
 * Unit tests for the global rate-limit middleware (task 8.4).
 *
 * Exercises:
 *   1. IP-only bucket (unauthenticated): 100 consecutive calls are
 *      allowed, the 101st is denied with a Problem Details 429 and
 *      `Retry-After: 1`.
 *   2. User bucket (authenticated with `authClaims.userId`): 500
 *      consecutive calls are allowed, the 501st is denied.
 *   3. Deny envelope: content-type is `application/problem+json`, the
 *      body carries `status: 429`, and `Retry-After` is a positive
 *      integer.
 *   4. IP derivation precedence: `CF-Connecting-IP` > first token of
 *      `x-forwarded-for` > `'unknown'`.
 *
 * No real Redis is used. The fake at `tests/helpers/fake-redis.ts`
 * (already exercised by the sliding-window unit tests) emulates the
 * sorted-set commands the limiter issues. This keeps the suite fast
 * and deterministic â€” no Testcontainers, no Upstash network.
 *
 * Validates: Requirements 14.3, 14.4.
 */

import { describe, expect, it, vi } from 'vitest';


import { FakeRedis } from '../../tests/helpers/fake-redis.js';
import {
    DEFAULT_IP_LIMIT,
    DEFAULT_USER_LIMIT,
    __resetRateLimitRedisCache,
    deriveClientIp,
    rateLimit,
    type RateLimitContext,
} from '../middleware/rate-limit.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a fake Hono context suitable for the middleware under test.
 *
 * The minimum surface is `env`, `req.header(name)` and `get(key)`. We
 * also expose an optional `header(k, v)` setter the middleware calls
 * when the allow branch surfaces `X-RateLimit-*` headers â€” it is not
 * asserted by every test but exists as a spy for the ones that care.
 */
function fakeContext(
    args: {
        headers?: Record<string, string>;
        variables?: Record<string, unknown>;
    } = {},
): RateLimitContext & { header: ReturnType<typeof vi.fn> } {
    const headers = new Map<string, string>(
        Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const variables = args.variables ?? {};
    return {
        env: {
            REDIS_URL: 'https://example.upstash.io',
            REDIS_TOKEN: 'test-token',
        },
        req: {
            header(name: string): string | undefined {
                return headers.get(name.toLowerCase());
            },
        },
        get(key: string): unknown {
            return variables[key];
        },
        header: vi.fn(),
    };
}

/**
 * Cast a {@link FakeRedis} to the Upstash `Redis` type expected by the
 * middleware factory. The fake implements the structural subset the
 * limiter actually uses; the cast keeps the test code honest without
 * dragging in the full `@upstash/redis` surface.
 */
function asRedis(fake: FakeRedis): Redis {
    return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  IP-only bucket â€” unauthenticated path                              */
/* ------------------------------------------------------------------ */

describe('rateLimit â€” IP bucket (unauthenticated)', () => {
    // Sprint-10 SP10.1 (Vague 38) — defaults sont 1000 req/60s
    // (cf. critique C1.2). Le test boucle DEFAULT_IP_LIMIT fois
    // donc il consomme 1000 itérations puis attend un 1001e refusé.
    // `Retry-After` est désormais ~60s (window) au lieu de 1s.
    it('allows up to DEFAULT_IP_LIMIT consecutive calls and denies the next with Retry-After in the window', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 1_000;
        const middleware = rateLimit({ redis: asRedis(fake) });

        for (let i = 0; i < DEFAULT_IP_LIMIT; i++) {
            const c = fakeContext({ headers: { 'CF-Connecting-IP': '1.2.3.4' } });
            const next = vi.fn().mockResolvedValue(undefined);
            const out = await middleware(c, next);
            expect(out).toBeUndefined();
            expect(next).toHaveBeenCalledTimes(1);
        }

        // 1001st call â€” must be denied.
        const c = fakeContext({ headers: { 'CF-Connecting-IP': '1.2.3.4' } });
        const next = vi.fn().mockResolvedValue(undefined);
        const out = await middleware(c, next);

        expect(next).not.toHaveBeenCalled();
        expect(out).toBeInstanceOf(Response);
        if (!(out instanceof Response)) return;
        expect(out.status).toBe(429);
        // Retry-After dans la fenêtre 60s, peu importe la valeur
        // exacte (dépend du temps écoulé entre la 1ère req et la
        // 1001e). On vérifie juste qu'elle est cohérente : 1 ≤ x ≤ 60.
        const retryAfter = Number(out.headers.get('retry-after'));
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(60);
        expect(out.headers.get('content-type')).toBe('application/problem+json');
    });

    it('keeps separate buckets for distinct client IPs', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 2_000;
        const middleware = rateLimit({ ipLimit: 2, redis: asRedis(fake) });

        const callWith = async (ip: string) => {
            const c = fakeContext({ headers: { 'CF-Connecting-IP': ip } });
            return middleware(c, vi.fn().mockResolvedValue(undefined));
        };

        // Saturate bucket Aâ€¦
        await callWith('1.1.1.1');
        await callWith('1.1.1.1');
        const denied = await callWith('1.1.1.1');
        expect(denied).toBeInstanceOf(Response);

        // â€¦bucket B is untouched.
        const allowedB = await callWith('2.2.2.2');
        expect(allowedB).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/*  User bucket â€” authenticated path                                   */
/* ------------------------------------------------------------------ */

describe('rateLimit â€” user bucket (authenticated)', () => {
    it('allows up to 500 consecutive calls and denies the 501st', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 10_000;
        const middleware = rateLimit({ redis: asRedis(fake) });

        const claims = { userId: 'u1', studioId: 's1', role: 'member' };

        for (let i = 0; i < DEFAULT_USER_LIMIT; i++) {
            const c = fakeContext({
                headers: { 'CF-Connecting-IP': '9.9.9.9' },
                variables: { authClaims: claims },
            });
            const next = vi.fn().mockResolvedValue(undefined);
            const out = await middleware(c, next);
            expect(out).toBeUndefined();
            expect(next).toHaveBeenCalledTimes(1);
        }

        // 501st â€” denied.
        const c = fakeContext({
            headers: { 'CF-Connecting-IP': '9.9.9.9' },
            variables: { authClaims: claims },
        });
        const next = vi.fn().mockResolvedValue(undefined);
        const out = await middleware(c, next);

        expect(next).not.toHaveBeenCalled();
        expect(out).toBeInstanceOf(Response);
        if (!(out instanceof Response)) return;
        expect(out.status).toBe(429);
    });

    it('keys the user bucket independently of the IP bucket', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 20_000;
        // Tight limits so we do not need 500 iterations.
        const middleware = rateLimit({
            ipLimit: 1,
            userLimit: 1,
            redis: asRedis(fake),
        });

        // An authenticated request burns the USER bucket, not the IP
        // bucket â€” so an immediately-following unauthenticated request
        // from the same IP must still be allowed (IP bucket untouched).
        const cAuth = fakeContext({
            headers: { 'CF-Connecting-IP': '3.3.3.3' },
            variables: { authClaims: { userId: 'alice' } },
        });
        const cAnon = fakeContext({
            headers: { 'CF-Connecting-IP': '3.3.3.3' },
        });

        expect(await middleware(cAuth, vi.fn().mockResolvedValue(undefined))).toBeUndefined();
        expect(await middleware(cAnon, vi.fn().mockResolvedValue(undefined))).toBeUndefined();
    });

    it('falls back to the IP bucket when authClaims lacks a userId', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 30_000;
        const middleware = rateLimit({ ipLimit: 1, redis: asRedis(fake) });

        // First call â€” allowed, burns the IP bucket.
        expect(
            await middleware(
                fakeContext({
                    headers: { 'CF-Connecting-IP': '4.4.4.4' },
                    variables: { authClaims: {} /* no userId */ },
                }),
                vi.fn().mockResolvedValue(undefined),
            ),
        ).toBeUndefined();

        // Second call â€” denied because the IP bucket was used on the
        // previous call (proving the middleware did not treat the
        // malformed claims as an authenticated user).
        const out = await middleware(
            fakeContext({
                headers: { 'CF-Connecting-IP': '4.4.4.4' },
                variables: { authClaims: { userId: '' } },
            }),
            vi.fn().mockResolvedValue(undefined),
        );
        expect(out).toBeInstanceOf(Response);
    });
});

/* ------------------------------------------------------------------ */
/*  Deny envelope shape                                                */
/* ------------------------------------------------------------------ */

describe('rateLimit â€” deny envelope', () => {
    it('returns Problem Details 429 with a positive integer Retry-After', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 40_000;
        const middleware = rateLimit({ ipLimit: 1, redis: asRedis(fake) });

        // Saturate, then request once more.
        await middleware(
            fakeContext({ headers: { 'CF-Connecting-IP': '5.5.5.5' } }),
            vi.fn().mockResolvedValue(undefined),
        );

        const out = await middleware(
            fakeContext({
                headers: { 'CF-Connecting-IP': '5.5.5.5' },
                variables: { traceId: 'trace-xyz' },
            }),
            vi.fn().mockResolvedValue(undefined),
        );

        expect(out).toBeInstanceOf(Response);
        if (!(out instanceof Response)) return;
        expect(out.status).toBe(429);
        expect(out.headers.get('content-type')).toBe('application/problem+json');

        const retryAfterRaw = out.headers.get('retry-after');
        expect(retryAfterRaw).not.toBeNull();
        const retryAfter = Number(retryAfterRaw);
        expect(Number.isInteger(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);

        const body = await out.json() as Record<string, unknown>;
        expect(body).toMatchObject({
            type: 'about:blank',
            title: 'Too Many Requests',
            status: 429,
            traceId: 'trace-xyz',
        });
    });

    it('emits traceId "unknown" when the tracing middleware did not set one', async () => {
        __resetRateLimitRedisCache();
        const fake = new FakeRedis();
        fake.nowMs = 50_000;
        const middleware = rateLimit({ ipLimit: 1, redis: asRedis(fake) });

        await middleware(
            fakeContext({ headers: { 'CF-Connecting-IP': '6.6.6.6' } }),
            vi.fn().mockResolvedValue(undefined),
        );
        const out = await middleware(
            fakeContext({ headers: { 'CF-Connecting-IP': '6.6.6.6' } }),
            vi.fn().mockResolvedValue(undefined),
        );

        expect(out).toBeInstanceOf(Response);
        if (!(out instanceof Response)) return;
        const body = await out.json() as Record<string, unknown>;
        expect(body['traceId']).toBe('unknown');
    });
});

/* ------------------------------------------------------------------ */
/*  IP derivation precedence                                           */
/* ------------------------------------------------------------------ */

describe('deriveClientIp â€” header precedence', () => {
    it('prefers CF-Connecting-IP over x-forwarded-for', () => {
        const ip = deriveClientIp({
            header(name) {
                if (name.toLowerCase() === 'cf-connecting-ip') return '10.0.0.1';
                if (name.toLowerCase() === 'x-forwarded-for') return '99.99.99.99';
                return undefined;
            },
        });
        expect(ip).toBe('10.0.0.1');
    });

    it('falls back to the first x-forwarded-for token when CF-Connecting-IP is absent', () => {
        const ip = deriveClientIp({
            header(name) {
                if (name.toLowerCase() === 'x-forwarded-for') {
                    return '11.11.11.11, 12.12.12.12, 13.13.13.13';
                }
                return undefined;
            },
        });
        expect(ip).toBe('11.11.11.11');
    });

    it('falls back to "unknown" when neither header is present', () => {
        const ip = deriveClientIp({
            header() {
                return undefined;
            },
        });
        expect(ip).toBe('unknown');
    });

    it('ignores blank CF-Connecting-IP and advances to x-forwarded-for', () => {
        const ip = deriveClientIp({
            header(name) {
                if (name.toLowerCase() === 'cf-connecting-ip') return '   ';
                if (name.toLowerCase() === 'x-forwarded-for') return '14.14.14.14';
                return undefined;
            },
        });
        expect(ip).toBe('14.14.14.14');
    });

    it('trims surrounding whitespace from the resolved IP', () => {
        const ip = deriveClientIp({
            header(name) {
                if (name.toLowerCase() === 'cf-connecting-ip') return '  15.15.15.15  ';
                return undefined;
            },
        });
        expect(ip).toBe('15.15.15.15');
    });
});

/**
 * Unit tests for the Redis-backed remaining-seat counter.
 *
 * Every test talks to a `Map`-backed fake Redis that implements just
 * the four commands the counter issues (`GET`, `SET`, `INCR`, `DECR`).
 * This keeps the suite hermetic — no Upstash, no network — and makes
 * it trivial to assert on the resulting key/value state.
 *
 * Covered scenarios:
 *   - Key layout: `class:{id}:remaining`, with an override prefix.
 *   - `reset(id, capacity)` writes the capacity and survives round-trip.
 *   - `getRemaining` returns `null` when the key is missing and an
 *     integer when it exists. Both `string` and `number` raw values
 *     are supported because the Upstash client can deserialise either
 *     depending on its `automaticDeserialization` flag.
 *   - `incr` / `decr` return the post-mutation value, starting from
 *     implicit 0 when the key is missing (matches real Redis
 *     semantics).
 *   - Booking-like sequence: reset → decr → decr → incr → getRemaining
 *     exercises all four operations in the shape the Reservations
 *     service will use.
 *   - `reset` rejects non-integer / negative capacities — defence in
 *     depth against a future caller passing through a bad value.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_COUNTER_PREFIX,
    createRedisRemainingCounter,
    type RedisLike,
} from '../counter.js';

/* ------------------------------------------------------------------ */
/*  FakeRedis                                                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal `RedisLike` stand-in backed by a `Map`. Stores values as
 * strings (real Redis is binary-safe, but for our integer-only use
 * case strings are a faithful-enough model) and exposes the raw map
 * so tests can sanity-check the written state.
 */
class FakeRedis implements RedisLike {
    public readonly store = new Map<string, string>();

    /**
     * Toggle between "raw string" and "auto-deserialised number"
     * return shapes. Upstash honours `automaticDeserialization`
     * (default `true`) which rehydrates JSON-looking values as their
     * native JS type on `GET`. The counter must cope with both.
     */
    public deserialize = false;

    // eslint-disable-next-line @typescript-eslint/require-await
    async get(key: string): Promise<unknown> {
        const v = this.store.get(key);
        if (v === undefined) return null;
        if (this.deserialize) {
            const n = Number(v);
            return Number.isFinite(n) ? n : v;
        }
        return v;
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async set(key: string, value: string | number): Promise<'OK'> {
        this.store.set(key, String(value));
        return 'OK';
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async incr(key: string): Promise<number> {
        const current = Number(this.store.get(key) ?? '0');
        const next = current + 1;
        this.store.set(key, String(next));
        return next;
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    async decr(key: string): Promise<number> {
        const current = Number(this.store.get(key) ?? '0');
        const next = current - 1;
        this.store.set(key, String(next));
        return next;
    }
}

const CLASS_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8a1';

/* ------------------------------------------------------------------ */
/*  Key layout                                                         */
/* ------------------------------------------------------------------ */

describe('createRedisRemainingCounter — key layout', () => {
    it('uses "class:{id}:remaining" by default', () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        expect(counter.key(CLASS_ID)).toBe(`class:${CLASS_ID}:remaining`);
        expect(DEFAULT_COUNTER_PREFIX).toBe('class');
    });

    it('honours a custom prefix', () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis, 'athlya:class');
        expect(counter.key(CLASS_ID)).toBe(`athlya:class:${CLASS_ID}:remaining`);
    });
});

/* ------------------------------------------------------------------ */
/*  getRemaining                                                       */
/* ------------------------------------------------------------------ */

describe('getRemaining', () => {
    it('returns null when the key is missing', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBeNull();
    });

    it('returns an integer when the key exists as a string', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 20);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(20);
    });

    it('returns an integer when the Upstash client auto-deserialises to a number', async () => {
        const redis = new FakeRedis();
        redis.deserialize = true;
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 7);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(7);
    });

    it('returns null when the stored value is not an integer (defence in depth)', async () => {
        // Pretend something else wrote a non-numeric string into the
        // key. The counter must not silently cast it to NaN or 0.
        const redis = new FakeRedis();
        redis.store.set(`class:${CLASS_ID}:remaining`, 'oops');
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBeNull();
    });

    it('returns null when the stored value is an empty string', async () => {
        const redis = new FakeRedis();
        redis.store.set(`class:${CLASS_ID}:remaining`, '');
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBeNull();
    });

    it('returns 0 correctly (regression guard against a falsy-null mix-up)', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 0);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(0);
    });

    it('returns negative integers verbatim (callers are responsible for clamping)', async () => {
        // The counter reader is a thin view over Redis; it does not
        // hide Algorithm 1's transient negative values. The
        // `listClasses` service is the layer that clamps.
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 0);
        await counter.decr(CLASS_ID);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(-1);
    });
});

/* ------------------------------------------------------------------ */
/*  incr / decr                                                        */
/* ------------------------------------------------------------------ */

describe('incr and decr', () => {
    it('starts from an implicit 0 when the key is missing', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(-1);
        await expect(counter.incr(CLASS_ID)).resolves.toBe(0);
    });

    it('decrements from a seeded value and returns the new count', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 3);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(2);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(1);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(0);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(-1);
    });

    it('incr cancels a losing decr (compensating pair)', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 1);

        // Two concurrent bookings racing for the last seat: both DECR,
        // one loses and compensates. The service layer is responsible
        // for picking the loser; here we just prove the arithmetic.
        await expect(counter.decr(CLASS_ID)).resolves.toBe(0);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(-1);
        await expect(counter.incr(CLASS_ID)).resolves.toBe(0); // loser compensates
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  reset                                                              */
/* ------------------------------------------------------------------ */

describe('reset', () => {
    it('writes the capacity to the Redis key', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 42);
        expect(redis.store.get(`class:${CLASS_ID}:remaining`)).toBe('42');
    });

    it('overwrites an existing value', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 20);
        await counter.decr(CLASS_ID);
        await counter.decr(CLASS_ID);
        await counter.reset(CLASS_ID, 30);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(30);
    });

    it('rejects non-integer capacities', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.reset(CLASS_ID, 1.5)).rejects.toBeInstanceOf(RangeError);
    });

    it('rejects negative capacities', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await expect(counter.reset(CLASS_ID, -1)).rejects.toBeInstanceOf(RangeError);
    });

    it('accepts zero capacity (fully-booked seed)', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 0);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  End-to-end booking-shape scenario                                  */
/* ------------------------------------------------------------------ */

describe('reset → decr → decr → incr → getRemaining', () => {
    it('leaves the counter at capacity - 1 after the compensating incr', async () => {
        const redis = new FakeRedis();
        const counter = createRedisRemainingCounter(redis);
        await counter.reset(CLASS_ID, 5);

        await expect(counter.decr(CLASS_ID)).resolves.toBe(4);
        await expect(counter.decr(CLASS_ID)).resolves.toBe(3);
        await expect(counter.incr(CLASS_ID)).resolves.toBe(4);
        await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(4);
    });
});

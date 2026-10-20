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

import { describe, expect, it, vi } from 'vitest';

import {
  COMPARE_AND_SET_SCRIPT,
  INVALID_EXPECTATION,
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
    const current = this.integerAt(key);
    const next = current + 1;
    this.store.set(key, String(next));
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async decr(key: string): Promise<number> {
    const current = this.integerAt(key);
    const next = current - 1;
    this.store.set(key, String(next));
    return next;
  }

  /** Redis INCR/DECR semantics: absent is 0, a non-integer is refused. */
  private integerAt(key: string): number {
    const raw = this.store.get(key) ?? '0';
    if (!isRedisInteger(raw)) throw new Error('ERR value is not an integer or out of range');
    return Number(raw);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setnx(key: string, value: string | number): Promise<number> {
    if (this.store.has(key)) return 0;
    this.store.set(key, String(value));
    return 1;
  }

  /**
   * Interprets {@link COMPARE_AND_SET_SCRIPT} only: the counter sends
   * no other script, and an unknown one fails loudly.
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (script !== COMPARE_AND_SET_SCRIPT) throw new Error('unexpected script');
    const [key] = keys;
    const [expected, value] = args;
    if (key === undefined || expected === undefined || value === undefined) {
      throw new Error('bad eval arguments');
    }
    const current = this.store.get(key);
    const hit =
      expected === ''
        ? current === undefined
        : expected === INVALID_EXPECTATION
          ? current !== undefined && !isRedisInteger(current)
          : current === expected;
    if (hit) {
      this.store.set(key, value);
      return 1;
    }
    return 0;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async mget(...keys: string[]): Promise<unknown[]> {
    return keys.map((k) => {
      const v = this.store.get(k);
      if (v === undefined) return null;
      if (this.deserialize) {
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      }
      return v;
    });
  }
}

/** Mirrors the script's check: the canonical decimal form of an integer. */
function isRedisInteger(raw: string): boolean {
  const n = Number(raw);
  return raw.length > 0 && Number.isInteger(n) && String(n) === raw;
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

/* ------------------------------------------------------------------ */
/*  getManyRemaining                                                   */
/* ------------------------------------------------------------------ */

const CLASS_ID_2 = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8b2';
const CLASS_ID_3 = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8c3';

describe('getManyRemaining', () => {
  it('returns values in the same order as classIds', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 20);
    await counter.reset(CLASS_ID_2, 5);

    await expect(counter.getManyRemaining([CLASS_ID, CLASS_ID_2])).resolves.toStrictEqual([20, 5]);
  });

  it('returns null for absent keys', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 10);

    await expect(counter.getManyRemaining([CLASS_ID, CLASS_ID_3])).resolves.toStrictEqual([
      10,
      null,
    ]);
  });

  it('returns [] for an empty input', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await expect(counter.getManyRemaining([])).resolves.toStrictEqual([]);
  });

  it('works with auto-deserialised number values', async () => {
    const redis = new FakeRedis();
    redis.deserialize = true;
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 12);
    await counter.reset(CLASS_ID_2, 7);

    await expect(counter.getManyRemaining([CLASS_ID, CLASS_ID_2])).resolves.toStrictEqual([12, 7]);
  });
});

/* ------------------------------------------------------------------ */
/*  decrOrInit — issue #412 (missing/evicted key guard)                */
/* ------------------------------------------------------------------ */

describe('decrOrInit', () => {
  it('seeds the key to capacity and decrements when the key is absent', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    // Key does not exist: without decrOrInit, plain decr would return -1
    // (Redis creates the key at 0, then decrements). With decrOrInit, the
    // key is seeded to capacity=20 first, then decremented to 19.
    await expect(counter.decrOrInit(CLASS_ID, 20)).resolves.toBe(19);
    expect(redis.store.get(`class:${CLASS_ID}:remaining`)).toBe('19');
  });

  it('does NOT re-seed an existing key — just decrements', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 5);
    // Key already exists with value 5; SETNX is a noop; DECR → 4.
    await expect(counter.decrOrInit(CLASS_ID, 99)).resolves.toBe(4);
    expect(redis.store.get(`class:${CLASS_ID}:remaining`)).toBe('4');
  });

  it('returns a positive value for the first booking on an evicted key (issue #412 regression)', async () => {
    // Simulates the eviction scenario from issue #412: the key was
    // evicted between class creation and this booking. A plain decr
    // would return -1 → waitlisted. decrOrInit seeds from capacity
    // and returns a non-negative value so the booking proceeds.
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    const remaining = await counter.decrOrInit(CLASS_ID, 30);
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  it('handles the "capacity = 1" boundary: first booking returns 0 (last seat)', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await expect(counter.decrOrInit(CLASS_ID, 1)).resolves.toBe(0);
  });

  it('repairs a non-integer value to capacity and decrements instead of failing', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    redis.store.set(counter.key(CLASS_ID), 'garbage');

    await expect(counter.decrOrInit(CLASS_ID, 10)).resolves.toBe(9);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(9);
  });

  it('surfaces a DECR failure that is not an invalid value', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 5);
    vi.spyOn(redis, 'decr').mockRejectedValueOnce(new Error('connection reset'));

    await expect(counter.decrOrInit(CLASS_ID, 5)).rejects.toThrow('connection reset');
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(5);
  });

  it('handles the "capacity = 0" class: first booking returns -1 → waitlist', async () => {
    // A class with capacity=0 is effectively closed. decrOrInit seeds
    // to 0 then decrements to -1, correctly signalling full capacity.
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await expect(counter.decrOrInit(CLASS_ID, 0)).resolves.toBe(-1);
  });
});

/* ------------------------------------------------------------------ */
/*  compareAndSet                                                      */
/* ------------------------------------------------------------------ */

describe('createRedisRemainingCounter: compareAndSet', () => {
  it('writes when the key still holds the expected value', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 5);

    await expect(counter.compareAndSet(CLASS_ID, 5, 3)).resolves.toBe(true);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(3);
  });

  it('refuses when a DECR moved the value after the read', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    await counter.reset(CLASS_ID, 5);
    await counter.decr(CLASS_ID);

    await expect(counter.compareAndSet(CLASS_ID, 5, 3)).resolves.toBe(false);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(4);
  });

  it('seeds an absent key only while it is still absent', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);

    await expect(counter.compareAndSet(CLASS_ID, null, 7)).resolves.toBe(true);
    await expect(counter.compareAndSet(CLASS_ID, null, 9)).resolves.toBe(false);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(7);
  });

  it('rejects a negative target value', async () => {
    const counter = createRedisRemainingCounter(new FakeRedis());
    await expect(counter.compareAndSet(CLASS_ID, null, -1)).rejects.toThrow(RangeError);
  });

  it('repairs a non-integer value only while it is still invalid', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);
    redis.store.set(counter.key(CLASS_ID), 'garbage');

    await expect(counter.compareAndSet(CLASS_ID, 'invalid', 6)).resolves.toBe(true);
    await expect(counter.compareAndSet(CLASS_ID, 'invalid', 9)).resolves.toBe(false);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBe(6);
  });

  it('does not treat an absent key as invalid', async () => {
    const counter = createRedisRemainingCounter(new FakeRedis());

    await expect(counter.compareAndSet(CLASS_ID, 'invalid', 6)).resolves.toBe(false);
    await expect(counter.getRemaining(CLASS_ID)).resolves.toBeNull();
  });
});

describe('createRedisRemainingCounter: inspectRemaining', () => {
  it('tells an absent key, an integer and a non-integer value apart', async () => {
    const redis = new FakeRedis();
    const counter = createRedisRemainingCounter(redis);

    await expect(counter.inspectRemaining(CLASS_ID)).resolves.toBeNull();
    await counter.reset(CLASS_ID, 4);
    await expect(counter.inspectRemaining(CLASS_ID)).resolves.toBe(4);
    redis.store.set(counter.key(CLASS_ID), '1.5');
    await expect(counter.inspectRemaining(CLASS_ID)).resolves.toBe('invalid');
    redis.store.set(counter.key(CLASS_ID), '');
    await expect(counter.inspectRemaining(CLASS_ID)).resolves.toBe('invalid');
  });
});

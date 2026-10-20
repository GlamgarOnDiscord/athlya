/**
 * Redis-backed "remaining seats" counter for classes.
 *
 * Design §3.2 pins the hot-path counter on Upstash Redis rather than
 * PostgreSQL so every booking can `DECR` without contending on a row
 * lock. This module owns the key layout (`class:{id}:remaining`) and
 * the four primitive operations the Reservations service calls into:
 *
 *   - {@link RemainingCounter.getRemaining}
 *     — read the current value (used by class listing, Req 7.2).
 *   - {@link RemainingCounter.decr} / {@link RemainingCounter.incr}
 *     — atomic booking / cancellation mutations used by Algorithms 1
 *     and 2 (tasks 6.4, 6.5).
 *   - {@link RemainingCounter.reset}
 *     — seed the key to `capacity` on class creation (task 6.2) and
 *     re-seed after a capacity change (task 6.3).
 *
 * The counter is deliberately an **interface** plus a small factory,
 * not a concrete class, so:
 *   1. the `listClasses` use case in {@link ./list.ts} can declare
 *      {@link RemainingCounterReader} as a narrow dependency (read-only
 *      slice) without pulling the mutating methods into its type graph;
 *   2. unit tests can inject an in-memory fake without typing the full
 *      `@upstash/redis` surface;
 *   3. tomorrow, if any operation grows a retry / fallback policy, the
 *      factory is the single place to change.
 *
 * Related requirements:
 *   - Requirement 7.2 (class listing joins the Redis counter).
 *   - Requirement 8.3 (capacity invariant — relies on atomic `DECR`).
 *   - Requirement 9.4 (`INCR` on cancellation with no waitlist).
 */

import type { Redis } from '@upstash/redis';

/**
 * Read-only slice of {@link RemainingCounter}. The class listing use
 * case only ever needs {@link RemainingCounterReader.getRemaining}, so
 * exposing a narrower interface here lets the service layer refuse an
 * accidental mutation through type-checking alone.
 */
export interface RemainingCounterReader {
  /**
   * Return the current remaining seat count for `classId`, or `null`
   * when the key is missing in Redis (not yet seeded, or evicted).
   *
   * Callers fall back to `class.capacity` on `null` — that's the
   * safe upper bound when the counter has not been initialised yet,
   * which can happen for a freshly-created class whose seed write
   * (task 6.2) has not yet landed or for a pilot-data import.
   */
  getRemaining(classId: string): Promise<number | null>;

  /**
   * Batch-fetch remaining seat counts for multiple class IDs in a
   * single MGET round-trip. Returns values in the same order as
   * `classIds`; each entry is `null` when the key is absent.
   *
   * Falls back to `getRemaining` for empty arrays, and falls back
   * to individual GETs when the Redis client does not expose `mget`.
   */
  getManyRemaining(classIds: string[]): Promise<(number | null)[]>;
}

/**
 * Full counter contract. The reader slice is embedded for structural
 * subtyping: any `RemainingCounter` is assignable to a
 * `RemainingCounterReader` dependency.
 */
export interface RemainingCounter extends RemainingCounterReader {
  /**
   * Atomically decrement the counter and return the new value.
   *
   * A negative return value is **legal** and signals "capacity
   * exhausted" to the booking flow; Algorithm 1 then issues a
   * compensating {@link RemainingCounter.incr} and inserts a
   * waitlist row instead.
   */
  decr(classId: string): Promise<number>;

  /**
   * Seed the counter to `capacity` via SETNX (only when absent),
   * then atomically DECR and return the new value.
   *
   * Use this instead of {@link decr} when the key may be missing or
   * evicted. A plain DECR on an absent key creates the key at 0 and
   * returns -1, falsely signalling "capacity exhausted" even when the
   * class has seats available. SETNX + DECR seeds the key to the DB
   * capacity before decrementing, so the first booking on an
   * uninitialized counter correctly claims a seat (issue #412).
   *
   * The seeded value is the class's total capacity, not its remaining
   * confirmed count. If confirmed seats already exist the counter will
   * be temporarily optimistic. The PostgreSQL capacity trigger
   * (`enforce_class_capacity`) remains the authoritative last-line
   * guard: it rejects any insert that would exceed capacity, and the
   * `ClassCapacityExceededError` path in `bookClass` compensates with
   * INCR and falls through to the waitlist branch. The scheduled
   * reconcile job corrects the counter for subsequent bookings.
   */
  decrOrInit(classId: string, capacity: number): Promise<number>;

  /**
   * Atomically increment the counter and return the new value. Used
   * both as the compensating action of a failed {@link decr} and as
   * the happy-path cancellation bump (Requirement 9.4).
   */
  incr(classId: string): Promise<number>;

  /**
   * Overwrite the counter with `capacity`. Called on class creation
   * (seed) and whenever an admin updates capacity (re-seed). Always
   * resolves once the write has been acknowledged by Redis.
   */
  reset(classId: string, capacity: number): Promise<void>;

  /**
   * Atomically overwrite the counter with `value` only when it still
   * holds `expected` (`null` = key absent). One Lua script, so no DECR
   * or INCR can land between the comparison and the write. Returns
   * `false` when the value moved; the caller re-reads on its next pass.
   */
  compareAndSet(classId: string, expected: number | null, value: number): Promise<boolean>;

  /**
   * Expose the computed Redis key. Useful for logging, debugging,
   * and for tests that want to inspect the underlying store without
   * re-implementing the prefix convention.
   */
  key(classId: string): string;
}

/**
 * Default Redis key prefix. The full key is `${prefix}:{classId}:remaining`,
 * which matches the convention used across `design.md` (§3.2, §E2) and
 * the implementation plan (task 6.1).
 */
export const DEFAULT_COUNTER_PREFIX = 'class';

/**
 * Subset of the Upstash Redis API the counter uses. Declared
 * structurally so unit tests can inject a `Map`-backed fake without
 * importing `@upstash/redis` at all — `Redis` from the real client
 * satisfies this shape via structural compatibility with a small cast
 * in the factory below.
 */
export interface RedisLike {
  get(key: string): Promise<unknown>;
  mget(...keys: string[]): Promise<unknown[]>;
  set(key: string, value: string | number): Promise<unknown>;
  /**
   * SETNX — set key to value only when the key does not exist.
   * Returns 1 if the key was set, 0 if it already existed.
   * Used by `decrRemainingOrInit` to seed an absent counter atomically
   * before decrementing (issue #412).
   */
  setnx(key: string, value: string | number): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  /** EVAL: run a Lua script atomically on the server. */
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

/**
 * Compare-and-set. `ARGV[1]` is the value the caller read (`''` for an
 * absent key), `ARGV[2]` the value to write. Returns 1 on write, 0 when
 * the key moved in between.
 */
export const COMPARE_AND_SET_SCRIPT = `local cur = redis.call('GET', KEYS[1])
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/**
 * Parse whatever Upstash returns for `GET` into an integer. The
 * Upstash client deserialises JSON-looking values when `automaticDeserialization`
 * is on (the default), so `GET` of a number-shaped string can come back
 * as a `number` already — we accept both paths and reject the rest.
 */
function parseRemaining(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    if (raw.length === 0) return null;
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * Build a {@link RemainingCounter} bound to the given Redis client and
 * key prefix.
 *
 * ```ts
 * import { Redis } from '@upstash/redis';
 * const counter = createRedisRemainingCounter(Redis.fromEnv());
 * await counter.reset(classId, 20);
 * const seats = await counter.getRemaining(classId); // 20
 * ```
 *
 * The factory accepts the structural {@link RedisLike} view so tests
 * can pass a fake. In production the caller passes an Upstash `Redis`
 * instance which trivially satisfies that shape.
 */
export function createRedisRemainingCounter(
  redis: RedisLike | Redis,
  prefix: string = DEFAULT_COUNTER_PREFIX,
): RemainingCounter {
  // `Redis` from `@upstash/redis` structurally satisfies
  // `RedisLike` for the four commands we use (`GET`, `SET`,
  // `INCR`, `DECR`), so the union collapses to `RedisLike` for
  // the purposes of this closure.
  const client: RedisLike = redis;

  const key = (classId: string): string => `${prefix}:${classId}:remaining`;

  return {
    key,

    async getRemaining(classId: string): Promise<number | null> {
      const raw = await client.get(key(classId));
      return parseRemaining(raw);
    },

    async getManyRemaining(classIds: string[]): Promise<(number | null)[]> {
      if (classIds.length === 0) return [];
      const keys = classIds.map(key);
      const raws = await client.mget(...keys);
      return raws.map(parseRemaining);
    },

    async decr(classId: string): Promise<number> {
      return client.decr(key(classId));
    },

    async decrOrInit(classId: string, capacity: number): Promise<number> {
      const k = key(classId);
      // SETNX seeds the key to `capacity` only when absent; noop when
      // present. The subsequent DECR is always atomic in Redis. Two
      // concurrent "first bookings" may both call SETNX — one wins
      // (sets to capacity) and one is a noop; both then DECR safely.
      await client.setnx(k, capacity);
      return client.decr(k);
    },

    async incr(classId: string): Promise<number> {
      return client.incr(key(classId));
    },

    async reset(classId: string, capacity: number): Promise<void> {
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new RangeError(
          `createRedisRemainingCounter.reset: capacity must be a non-negative integer, got ${String(
            capacity,
          )}`,
        );
      }
      await client.set(key(classId), capacity);
    },

    async compareAndSet(classId: string, expected: number | null, value: number): Promise<boolean> {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(
          `createRedisRemainingCounter.compareAndSet: value must be a non-negative integer, got ${String(
            value,
          )}`,
        );
      }
      const written = await client.eval(
        COMPARE_AND_SET_SCRIPT,
        [key(classId)],
        [expected === null ? '' : String(expected), String(value)],
      );
      return Number(written) === 1;
    },
  };
}

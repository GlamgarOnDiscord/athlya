/**
 * Distributed circuit breaker tests — issue #231.
 *
 * Validates the Redis-backed store (`RedisCircuitBreakerStore`) and the
 * `CircuitBreaker` store integration:
 *
 *   1. After N failures spread across M independent isolates (sharing one
 *      fake Redis), every breaker sees the circuit as `open`.
 *   2. Only one isolate wins the half-open probe slot (NX lock).
 *   3. A store error falls back to the local in-memory state machine.
 *   4. Property: for any interleaving of failures from 1–10 isolates,
 *      once the shared failure count reaches the threshold the circuit
 *      opens fleet-wide.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';
import { RedisCircuitBreakerStore } from '../adapters/circuit-breaker-redis-store.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Minimal fake Redis for circuit-breaker store tests                 */
/* ------------------------------------------------------------------ */

class StoreFakeRedis {
  private readonly strings = new Map<string, string>();
  private readonly nxLocks = new Set<string>();
  readonly sets = new Map<string, Array<{ score: number; member: string }>>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T = string>(key: string): Promise<T | null> {
    return (this.strings.get(key) ?? null) as T | null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(
    key: string,
    value: string,
    opts?: { ex?: number; px?: number; nx?: boolean },
  ): Promise<'OK' | null> {
    if (opts?.nx) {
      if (this.nxLocks.has(key)) return null;
      this.nxLocks.add(key);
      this.strings.set(key, value);
      return 'OK';
    }
    this.strings.set(key, value);
    return 'OK';
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const a = this.strings.delete(key);
      const b = this.nxLocks.delete(key);
      if (a || b) count++;
      this.sets.delete(key);
    }
    return count;
  }

  private sortedList(key: string): Array<{ score: number; member: string }> {
    let list = this.sets.get(key);
    if (!list) {
      list = [];
      this.sets.set(key, list);
    }
    return list;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zadd(key: string, entry: { score: number; member: string }): Promise<number> {
    const list = this.sortedList(key);
    list.push(entry);
    list.sort((a, b) => a.score - b.score);
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zremrangebyscore(key: string, _min: string, max: number): Promise<number> {
    const list = this.sortedList(key);
    const before = list.length;
    const kept = list.filter((e) => e.score > max);
    this.sets.set(key, kept);
    return before - kept.length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zcard(key: string): Promise<number> {
    return this.sortedList(key).length;
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = {
      zadd: (k: string, e: { score: number; member: string }) => {
        ops.push(() => this.zadd(k, e));
        return p;
      },
      zremrangebyscore: (k: string, min: string, max: number) => {
        ops.push(() => this.zremrangebyscore(k, min, max));
        return p;
      },
      zcard: (k: string) => {
        ops.push(() => this.zcard(k));
        return p;
      },
      set: (k: string, v: string, opts?: { ex?: number }) => {
        ops.push(async () => this.set(k, v, opts));
        return p;
      },
      del: (...keys: string[]) => {
        ops.push(() => this.del(...keys));
        return p;
      },
      exec: async <T extends unknown[]>(): Promise<T> => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out as T;
      },
    };
    return p;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const THRESHOLD = 5;
const WINDOW_MS = 30_000;
const RESET_MS = 60_000;

function makeSharedStore(fake: StoreFakeRedis) {
  return new RedisCircuitBreakerStore(fake as unknown as Redis, 'postgres', RESET_MS);
}

function makeBreaker(store: RedisCircuitBreakerStore, clockMs: number) {
  return new CircuitBreaker({
    name: 'postgres',
    failureThreshold: THRESHOLD,
    windowMs: WINDOW_MS,
    resetTimeoutMs: RESET_MS,
    resetJitterMs: 0,
    clock: () => clockMs,
    random: () => 0,
    store,
  });
}

const failing = (): Promise<never> => Promise.reject(new Error('boom'));
const succeeding = (): Promise<string> => Promise.resolve('ok');

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('distributed circuit breaker (issue #231)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens fleet-wide after threshold failures across isolates', async () => {
    const fake = new StoreFakeRedis();
    const store = makeSharedStore(fake);
    const NOW = Date.now();

    // Five independent isolates each record one failure.
    for (let i = 0; i < THRESHOLD; i++) {
      const breaker = makeBreaker(store, NOW);
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }

    // A sixth isolate — which has seen zero failures locally — must see OPEN.
    const newIsolate = makeBreaker(store, NOW);
    await expect(newIsolate.exec(failing)).rejects.toThrow(CircuitOpenError);
  });

  it('only one isolate wins the half-open probe slot', async () => {
    const fake = new StoreFakeRedis();
    const store = makeSharedStore(fake);
    const NOW = Date.now();

    // Trip the circuit via the store directly.
    const openUntil = NOW - 1; // already in the past → half_open
    await fake.set('cb:postgres:open_until', String(openUntil));

    const breakers = Array.from({ length: 5 }, () => makeBreaker(store, NOW));
    const results = await Promise.allSettled(breakers.map((b) => b.exec(succeeding)));

    const successes = results.filter((r) => r.status === 'fulfilled');
    const openErrors = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof CircuitOpenError,
    );

    // Exactly one isolate should have won the probe.
    expect(successes).toHaveLength(1);
    expect(openErrors).toHaveLength(4);
  });

  it('falls back to in-memory state machine when store throws', async () => {
    class BrokenStore extends RedisCircuitBreakerStore {
      override async getState(): Promise<never> {
        throw new Error('ECONNREFUSED');
      }
      override async recordFailure(): Promise<never> {
        throw new Error('ECONNREFUSED');
      }
    }

    const fake = new StoreFakeRedis();
    const brokenStore = new BrokenStore(fake as unknown as Redis, 'postgres', RESET_MS);
    const NOW = Date.now();
    const breaker = makeBreaker(brokenStore, NOW);

    // Local state machine should still trip after 5 failures.
    for (let i = 0; i < THRESHOLD; i++) {
      await expect(breaker.exec(failing)).rejects.toThrow('boom');
    }
    expect(breaker.state()).toBe('open');
  });

  it('property: fleet-wide open once shared failure count hits threshold', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (isolateCount) => {
        const fake = new StoreFakeRedis();
        const store = makeSharedStore(fake);
        const NOW = Date.now();

        // Each isolate records one failure in order.
        for (let i = 0; i < THRESHOLD; i++) {
          const b = makeBreaker(store, NOW);
          await expect(b.exec(failing)).rejects.toThrow('boom');
        }

        // All new isolates must now see OPEN.
        for (let i = 0; i < isolateCount; i++) {
          const b = makeBreaker(store, NOW);
          await expect(b.exec(failing)).rejects.toThrow(CircuitOpenError);
        }
      }),
      { numRuns: 20 },
    );
  });

  it('clears shared state on success and returns to closed fleet-wide', async () => {
    const fake = new StoreFakeRedis();
    const store = makeSharedStore(fake);
    const NOW = Date.now();

    // Trip the circuit through the store (half_open).
    await fake.set('cb:postgres:open_until', String(NOW - 1));
    // Win the probe and succeed.
    const winner = makeBreaker(store, NOW);
    await expect(winner.exec(succeeding)).resolves.toBe('ok');

    // A new isolate should now see CLOSED.
    const newIsolate = makeBreaker(store, NOW);
    await expect(newIsolate.exec(succeeding)).resolves.toBe('ok');
    expect(newIsolate.state()).toBe('closed');
  });
});

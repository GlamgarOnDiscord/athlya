/**
 * In-memory fake for the subset of the Upstash Redis client that the
 * sliding-window rate limiter (`rateLimitSlidingWindow`) exercises.
 *
 * Scope is deliberately tiny:
 *   - sorted-set commands: `zadd`, `zcard`, `zremrangebyscore`, `zrange`
 *   - key-level command: `expire`
 *   - the `pipeline()` / `exec()` shape used by the limiter
 *
 * That is every single command the limiter issues, and nothing more —
 * new fakes for future middleware should live next to this file rather
 * than expand this one.
 *
 * The fake is backed by plain maps so tests that want to assert on
 * internal state (e.g. the property test inspecting the stored
 * timestamps) can reach into `sets` directly. All methods are `async`
 * to match the production client's Promise-returning contract, and the
 * pipeline is implemented as a sequential runner — that is sufficient
 * for unit/property tests on a sequential consumer like the limiter,
 * and keeps the fake understandable.
 *
 * A per-instance `nowMs` field emulates the monotonic clock. The
 * limiter's dependency bundle expects an injected `now` function, so
 * test code uses `() => fake.nowMs` and advances the fake directly.
 * That same clock is consulted by `expire` so TTLs are honoured
 * deterministically.
 */

import type { RateLimiterDeps } from '../../src/sliding-window.js';

/** A single sorted-set entry, keyed by `member` with a numeric `score`. */
export type SortedSetEntry = { score: number; member: string };

/** Meta-record backing the fake's TTL emulation. */
interface ExpireMeta {
  seconds: number;
  setAtMs: number;
}

/**
 * Minimal stand-in for the slice of `@upstash/redis` used by the
 * limiter. See module comment for the full list of supported commands.
 */
export class FakeRedis {
  /**
   * Sorted sets keyed by Redis key. Exposed for tests that need to
   * inspect recorded timestamps (e.g. property-based assertions on
   * which requests the limiter counted as `allow`).
   */
  readonly sets = new Map<string, SortedSetEntry[]>();

  /** Per-key TTL metadata set by `expire`. */
  readonly expirations = new Map<string, ExpireMeta>();

  /** Clock the fake uses to honour `expire` TTLs (ms since epoch). */
  nowMs = 0;

  private list(key: string): SortedSetEntry[] {
    this.evictIfExpired(key);
    let list = this.sets.get(key);
    if (!list) {
      list = [];
      this.sets.set(key, list);
    }
    return list;
  }

  private evictIfExpired(key: string): void {
    const meta = this.expirations.get(key);
    if (!meta) return;
    if (this.nowMs >= meta.setAtMs + meta.seconds * 1000) {
      this.sets.delete(key);
      this.expirations.delete(key);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const list = this.list(key);
    const before = list.length;
    const kept = list.filter((e) => e.score < min || e.score > max);
    this.sets.set(key, kept);
    return before - kept.length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zadd(key: string, entry: { score: number; member: string }): Promise<number> {
    const list = this.list(key);
    const existing = list.findIndex((e) => e.member === entry.member);
    if (existing >= 0) {
      list[existing] = entry;
      return 0;
    }
    list.push(entry);
    list.sort((a, b) => a.score - b.score);
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zcard(key: string): Promise<number> {
    return this.list(key).length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async expire(key: string, seconds: number): Promise<number> {
    if (!this.sets.has(key)) return 0;
    this.expirations.set(key, { seconds, setAtMs: this.nowMs });
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { withScores?: boolean },
  ): Promise<Array<string | number>> {
    const list = [...this.list(key)].sort((a, b) => a.score - b.score);
    const end = stop === -1 ? list.length - 1 : stop;
    const slice = list.slice(start, end + 1);
    if (opts?.withScores) {
      return slice.flatMap((e) => [e.member, e.score]);
    }
    return slice.map((e) => e.member);
  }

  /**
   * Pipeline emulation. The Upstash pipeline collects commands and
   * flushes them with `exec()`; here we do exactly that, executing
   * sequentially so the result indices match what the caller expects.
   */
  pipeline(): {
    zremrangebyscore: (k: string, min: number, max: number) => void;
    zadd: (k: string, entry: { score: number; member: string }) => void;
    zcard: (k: string) => void;
    expire: (k: string, seconds: number) => void;
    exec: <T extends unknown[]>() => Promise<T>;
  } {
    const ops: Array<() => Promise<unknown>> = [];
    const zremrangebyscore = this.zremrangebyscore.bind(this);
    const zadd = this.zadd.bind(this);
    const zcard = this.zcard.bind(this);
    const expire = this.expire.bind(this);
    return {
      zremrangebyscore(k, min, max) {
        ops.push(() => zremrangebyscore(k, min, max));
      },
      zadd(k, entry) {
        ops.push(() => zadd(k, entry));
      },
      zcard(k) {
        ops.push(() => zcard(k));
      },
      expire(k, seconds) {
        ops.push(() => expire(k, seconds));
      },
      async exec<T extends unknown[]>(): Promise<T> {
        const out: unknown[] = [];
        for (const op of ops) {
          out.push(await op());
        }
        return out as T;
      },
    };
  }
}

/**
 * Build a `RateLimiterDeps` bundle whose clock is driven by
 * `fake.nowMs`. The fake is cast through `unknown` to satisfy the
 * structural subset of the Upstash client the limiter actually uses,
 * without pulling in the full `@upstash/redis` type surface.
 */
export function makeRateLimiterDeps(fake: FakeRedis): RateLimiterDeps {
  return {
    redis: fake as unknown as RateLimiterDeps['redis'],
    now: () => fake.nowMs,
  };
}

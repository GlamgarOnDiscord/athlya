/**
 * Upstash Redis backend for the distributed circuit breaker (issue #231).
 *
 * Data model
 * ----------
 * All keys are prefixed with `cb:{name}:`.
 *
 *   cb:{name}:open_until  — string (ms timestamp).
 *                           Absent     → closed.
 *                           value > now → open.
 *                           value ≤ now → half_open.
 *                           TTL = 10 × resetTimeoutMs for automatic cleanup.
 *
 *   cb:{name}:failures    — sorted set; score = ms, member = unique string.
 *                           Entries older than windowMs pruned on each write.
 *
 *   cb:{name}:probe       — NX lock that serialises the half-open probe.
 *                           Present = probe in flight. TTL = resetTimeoutMs.
 *
 * Atomicity
 * ---------
 * `recordFailure` uses a two-step pipeline (ZADD + ZREMRANGEBYSCORE + ZCARD)
 * followed by a conditional SET. The TOCTOU window (two isolates both see
 * count = threshold and both SET open_until) is harmless — both set the same
 * value and the result is idempotent.
 *
 * Graceful degradation
 * --------------------
 * All methods throw on Redis errors. The caller (`CircuitBreaker.exec`) wraps
 * every call in try/catch and falls back to the local in-memory state machine.
 */

import type { Redis } from '@upstash/redis';

import type { CircuitBreakerStore, CircuitState } from '../circuit-breaker.js';

export class RedisCircuitBreakerStore implements CircuitBreakerStore {
  private readonly redis: Redis;
  private readonly keyOpenUntil: string;
  private readonly keyFailures: string;
  private readonly keyProbe: string;
  private readonly cleanupTtlMs: number;

  constructor(redis: Redis, name: string, resetTimeoutMs: number) {
    this.redis = redis;
    const prefix = `cb:${name}`;
    this.keyOpenUntil = `${prefix}:open_until`;
    this.keyFailures = `${prefix}:failures`;
    this.keyProbe = `${prefix}:probe`;
    this.cleanupTtlMs = resetTimeoutMs * 10;
  }

  async getState(now: number): Promise<CircuitState> {
    const raw = await this.redis.get<string>(this.keyOpenUntil);
    if (raw === null || raw === undefined) return 'closed';
    const openUntil = Number(raw);
    if (!Number.isFinite(openUntil)) return 'closed';
    return openUntil > now ? 'open' : 'half_open';
  }

  async recordFailure(
    now: number,
    windowMs: number,
    failureThreshold: number,
    resetTimeoutMs: number,
  ): Promise<boolean> {
    const member = `${String(now)}:${Math.random().toString(36).slice(2)}`;
    const cutoff = now - windowMs;

    const pipeline = this.redis.pipeline();
    pipeline.zadd(this.keyFailures, { score: now, member });
    pipeline.zremrangebyscore(this.keyFailures, '-inf', cutoff);
    pipeline.zcard(this.keyFailures);
    const results = await pipeline.exec<[unknown, unknown, number]>();
    const count = results[2];

    if (count >= failureThreshold) {
      const openUntil = now + resetTimeoutMs;
      const ttlSec = Math.ceil(this.cleanupTtlMs / 1000);
      await this.redis
        .pipeline()
        .set(this.keyOpenUntil, String(openUntil), { ex: ttlSec })
        .del(this.keyFailures)
        .exec();
      return true;
    }
    return false;
  }

  async recordSuccess(): Promise<void> {
    await this.redis.pipeline().del(this.keyOpenUntil).del(this.keyFailures).exec();
  }

  async recordOpen(openUntil: number): Promise<void> {
    const ttlSec = Math.ceil(this.cleanupTtlMs / 1000);
    await this.redis.set(this.keyOpenUntil, String(openUntil), { ex: ttlSec });
  }

  async tryAcquireProbe(ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(this.keyProbe, '1', {
      nx: true,
      px: ttlMs,
    });
    return result === 'OK';
  }

  async releaseProbe(): Promise<void> {
    await this.redis.del(this.keyProbe);
  }
}

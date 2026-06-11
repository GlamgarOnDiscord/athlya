/**
 * Unit tests for {@link shouldAllowLogin}.
 *
 * The throttle is a thin composition over `@athlya/ratelimit`, so the
 * scope of this suite is deliberately narrow: we verify only the
 * policy-level invariants from Requirement 1.6 and the key-isolation
 * properties that depend on correct bucket construction. The exactness
 * of the underlying sliding-window algorithm is covered by the
 * property-based test in `@athlya/ratelimit`'s own suite and by
 * `sliding-window.test.ts` in that package.
 *
 * The suite uses the same in-memory {@link FakeRedis} contract as
 * `packages/ratelimit/tests/sliding-window.test.ts`. We duplicate it
 * here rather than importing it across package boundaries because
 * `@athlya/ratelimit` does not export its test utilities (nor should
 * it — they are test-only artefacts).
 */

import { describe, expect, it } from 'vitest';

import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_SEC,
  loginBucketKey,
  normalizeLoginEmail,
  shouldAllowLogin,
} from '../throttle.js';

import type { LoginThrottleDeps } from '../throttle.js';

type SortedSetEntry = { score: number; member: string };

interface ExpireMeta {
  seconds: number;
  setAtMs: number;
}

/**
 * Minimal stand-in for the subset of `@upstash/redis` used by the
 * underlying sliding-window limiter. Mirrors
 * `packages/api/src/__tests__/ratelimit.test.ts` so behaviour under
 * the throttle exactly matches behaviour under the primitive.
 */
class FakeRedis {
  readonly sets = new Map<string, SortedSetEntry[]>();
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

/** Build a deps bundle whose clock is driven by `fake.nowMs`. */
function makeDeps(fake: FakeRedis): LoginThrottleDeps {
  return {
    redis: fake as unknown as LoginThrottleDeps['redis'],
    now: () => fake.nowMs,
  };
}

const IP_A = '203.0.113.10';
const IP_B = '203.0.113.11';
const EMAIL_A = 'alice@example.com';
const EMAIL_B = 'bob@example.com';

describe('shouldAllowLogin', () => {
  it('allows the first 5 attempts and denies the 6th with retryAfterSec in (0, 900]', async () => {
    const fake = new FakeRedis();
    const deps = makeDeps(fake);
    fake.nowMs = 1_000;

    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      const decision = await shouldAllowLogin(IP_A, EMAIL_A, deps);
      expect(decision.allow).toBe(true);
      expect(decision.remaining).toBe(LOGIN_ATTEMPT_LIMIT - (i + 1));
      expect(decision.retryAfterSec).toBeUndefined();
      fake.nowMs += 1;
    }

    const denied = await shouldAllowLogin(IP_A, EMAIL_A, deps);
    expect(denied.allow).toBe(false);
    expect(denied.remaining).toBeUndefined();
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(LOGIN_WINDOW_SEC);
  });

  it('resets after the 900 s window has elapsed and allows again', async () => {
    const fake = new FakeRedis();
    const deps = makeDeps(fake);
    fake.nowMs = 0;

    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      const d = await shouldAllowLogin(IP_A, EMAIL_A, deps);
      expect(d.allow).toBe(true);
    }

    // Immediate follow-up is denied…
    const deniedImmediately = await shouldAllowLogin(IP_A, EMAIL_A, deps);
    expect(deniedImmediately.allow).toBe(false);

    // …but once the window has fully slid off, we're allowed again.
    fake.nowMs += LOGIN_WINDOW_SEC * 1000 + 1;
    const afterWindow = await shouldAllowLogin(IP_A, EMAIL_A, deps);
    expect(afterWindow.allow).toBe(true);
    expect(afterWindow.remaining).toBe(LOGIN_ATTEMPT_LIMIT - 1);
  });

  it('isolates buckets by IP for the same email', async () => {
    const fake = new FakeRedis();
    const deps = makeDeps(fake);
    fake.nowMs = 0;

    // Saturate the window for (IP_A, EMAIL_A).
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      await shouldAllowLogin(IP_A, EMAIL_A, deps);
    }
    const deniedSameIp = await shouldAllowLogin(IP_A, EMAIL_A, deps);
    expect(deniedSameIp.allow).toBe(false);

    // A different IP attacking the same account has its own fresh bucket.
    const otherIp = await shouldAllowLogin(IP_B, EMAIL_A, deps);
    expect(otherIp.allow).toBe(true);
    expect(otherIp.remaining).toBe(LOGIN_ATTEMPT_LIMIT - 1);
  });

  it('isolates buckets by email for the same IP', async () => {
    const fake = new FakeRedis();
    const deps = makeDeps(fake);
    fake.nowMs = 0;

    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT; i++) {
      await shouldAllowLogin(IP_A, EMAIL_A, deps);
    }
    const deniedSameEmail = await shouldAllowLogin(IP_A, EMAIL_A, deps);
    expect(deniedSameEmail.allow).toBe(false);

    // Same IP brute-forcing another user has its own bucket.
    const otherEmail = await shouldAllowLogin(IP_A, EMAIL_B, deps);
    expect(otherEmail.allow).toBe(true);
    expect(otherEmail.remaining).toBe(LOGIN_ATTEMPT_LIMIT - 1);
  });

  it('folds email case and whitespace into the same bucket (no bypass via casing)', async () => {
    const fake = new FakeRedis();
    const deps = makeDeps(fake);
    fake.nowMs = 0;

    // Five alternating-case attempts should all land in the same bucket.
    const variants = [
      'alice@example.com',
      'Alice@example.com',
      'ALICE@EXAMPLE.COM',
      '  alice@example.com  ',
      'alice@Example.com',
    ];
    for (const variant of variants) {
      const d = await shouldAllowLogin(IP_A, variant, deps);
      expect(d.allow).toBe(true);
    }

    // The sixth (lower-case) attempt must be denied — all five
    // previous attempts were counted against the same canonical bucket.
    const denied = await shouldAllowLogin(IP_A, 'alice@example.com', deps);
    expect(denied.allow).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(LOGIN_WINDOW_SEC);
  });
});

describe('normalizeLoginEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeLoginEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeLoginEmail('Alice@Example.COM');
    expect(normalizeLoginEmail(once)).toBe(once);
  });

  it('collapses IDN Unicode domain to punycode (issue #243)', () => {
    expect(normalizeLoginEmail('alice@café.com')).toBe('alice@xn--caf-dma.com');
  });

  it('treats Unicode and punycode domain as the same bucket key', () => {
    expect(normalizeLoginEmail('alice@café.com')).toBe(
      normalizeLoginEmail('alice@xn--caf-dma.com'),
    );
  });

  it('returns trimmed+lowercased form when domain is unparseable', () => {
    expect(normalizeLoginEmail('alice@[invalid')).toBe('alice@[invalid');
  });

  it('handles email with no @ sign gracefully', () => {
    expect(normalizeLoginEmail('notanemail')).toBe('notanemail');
  });
});

describe('loginBucketKey (Sprint-3 Slice 3.2 — S5-007 hashed key)', () => {
  it('builds a stable hex-suffixed key (no raw IP / email leak)', async () => {
    const key = await loginBucketKey(IP_A, EMAIL_A);
    expect(key.startsWith('auth:login:')).toBe(true);
    expect(key).not.toContain(IP_A);
    expect(key).not.toContain(EMAIL_A);
    const suffix = key.slice('auth:login:'.length);
    expect(suffix).toMatch(/^[0-9a-f]{24}$/);
  });

  it('produces the same key for identical inputs (deterministic)', async () => {
    const k1 = await loginBucketKey(IP_A, EMAIL_A);
    const k2 = await loginBucketKey(IP_A, EMAIL_A);
    expect(k1).toBe(k2);
  });

  it('collides across email casing (normalisation preserved)', async () => {
    expect(await loginBucketKey(IP_A, 'Alice@Example.COM')).toBe(
      await loginBucketKey(IP_A, 'alice@example.com'),
    );
  });

  it('produces distinct keys for distinct (ip, email) pairs', async () => {
    const a = await loginBucketKey(IP_A, EMAIL_A);
    const b = await loginBucketKey('9.9.9.9', EMAIL_A);
    const c = await loginBucketKey(IP_A, 'bob@example.com');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('rejects empty ip or email', async () => {
    await expect(loginBucketKey('', EMAIL_A)).rejects.toThrow(TypeError);
    await expect(loginBucketKey(IP_A, '')).rejects.toThrow(TypeError);
  });
});

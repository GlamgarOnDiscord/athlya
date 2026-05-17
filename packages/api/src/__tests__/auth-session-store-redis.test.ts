/**
 * Unit tests for the Sprint-2 SP2.1 (Vague 29) atomic refresh-token
 * rotation + family-tree revoke implementation in
 * `adapters/auth-session-store-redis.ts`.
 *
 * Findings exercised
 * ------------------
 *   • S2-002 [CRITICAL] — atomic rotate. Two concurrent
 *     `rotate(oldSid, ...)` calls must result in exactly one
 *     `kind: 'ok'` and one `kind: 'unknown'`. The Lua-backed
 *     `GETDEL + SET NX` pair guarantees this regardless of HTTP
 *     interleaving.
 *
 *   • S2-004 [HIGH] — family-tree revoke on reuse. Replaying an
 *     already-rotated sid must surface as
 *     `kind: 'reuse_detected'` (so the auth service can revoke the
 *     family + write the audit + emit the suspicious event).
 *
 *   • Backward compat — payloads written before SP2.1 (no
 *     `rootSid` / `parentSid`) must remain rotateable; the reader
 *     falls back to `rootSid = sid` so the family-tree machinery
 *     stays consistent for rotations after the deploy.
 *
 * Test surface
 * ------------
 * A purpose-built `FakeUpstashRedis` mirrors the subset of the
 * Upstash REST client this adapter consumes (`get`, `set`, `del`,
 * `sadd`, `srem`, `smembers`, `exists`, `eval`). The `eval`
 * implementation is a minimal Lua interpreter — it is NOT a generic
 * Lua VM, only a hand-rolled executor for the exact script in
 * `ROTATE_LUA`. Any future Lua script added to the adapter would
 * need a parallel branch here.
 *
 * The fake lives inline because the existing `tests/helpers/fake-redis.ts`
 * is sorted-set-only (rate-limiter scope). Lifting it into a shared
 * helper is deferred until a second consumer needs the same string /
 * set surface — premature generalisation is a smell.
 *
 * @see packages/api/src/adapters/auth-session-store-redis.ts
 * @see docs/security/audit-S2-auth.md S2-002, S2-004
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRedisSessionStore } from '../adapters/auth-session-store-redis.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Fake Redis                                                         */
/* ------------------------------------------------------------------ */

interface StringEntry {
  value: string;
  expiresAtMs: number | null;
}

class FakeUpstashRedis {
  /** String key → value + optional absolute expiry. */
  readonly strings = new Map<string, StringEntry>();
  /** SET key → set of members. */
  readonly sets = new Map<string, Set<string>>();

  /**
   * Optional latch. When `getDelayMs > 0`, the next N calls to
   * `eval` block for that many ms before evaluating the script —
   * lets the atomicity test schedule two concurrent rotations that
   * actually overlap inside the Lua call.
   */
  evalDelayMs = 0;

  private isExpired(entry: StringEntry, nowMs: number): boolean {
    return entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs;
  }

  private now(): number {
    return Date.now();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (this.isExpired(entry, this.now())) {
      this.strings.delete(key);
      return null;
    }
    return entry.value as unknown as T;
  }

  async set(
    key: string,
    value: string,
    options?: { ex?: number; nx?: boolean },
  ): Promise<'OK' | null> {
    const ex = options?.ex;
    if (options?.nx === true && this.strings.has(key)) {
      const existing = this.strings.get(key)!;
      if (!this.isExpired(existing, this.now())) {
        return null;
      }
    }
    const expiresAtMs = typeof ex === 'number' && ex > 0 ? this.now() + ex * 1000 : null;
    this.strings.set(key, { value, expiresAtMs });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added += 1;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed += 1;
    }
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    const now = this.now();
    for (const key of keys) {
      const entry = this.strings.get(key);
      if (entry && !this.isExpired(entry, now)) count += 1;
      else if (this.sets.has(key)) count += 1;
    }
    return count;
  }

  /**
   * Minimal Lua interpreter — implements EXACTLY the
   * `ROTATE_LUA` script from `auth-session-store-redis.ts`.
   * Reproducing Lua's semantics by hand is the cost of doing
   * atomicity testing without a real Redis; the alternative would
   * be testcontainers, which Sprint 1's "low-token" envelope
   * cannot afford.
   *
   * The body is a near-verbatim transcription of the Lua script;
   * any future change to the script must be mirrored here.
   */
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    if (this.evalDelayMs > 0) {
      const delay = this.evalDelayMs;
      this.evalDelayMs = 0;
      await new Promise((r) => setTimeout(r, delay));
    }

    // Sanity guard — bail out loudly if a future commit adds a
    // new script and this fake hasn't been updated.
    if (!script.includes('GETDEL') || !script.includes("'NX'")) {
      console.error('FakeUpstashRedis.eval: unknown script', { script });
      throw new Error('FakeUpstashRedis.eval: unknown Lua script');
    }

    const [
      oldSidKey,
      newSidKey,
      userIndexKey,
      familyIndexKey,
      ,
      // sidToRootOldKey not consumed (the script never
      // touches it — only the new sid's pointer is written),
      sidToRootNewKey,
    ] = keys;

    const [newPayloadJson, ttlSecStr, oldSid, newSid, rootSid, sidToRootTtlStr] = args;

    // Step 1 — GETDEL old.
    const oldEntry = this.strings.get(oldSidKey ?? '');
    const now = this.now();
    if (!oldEntry || this.isExpired(oldEntry, now)) {
      return [0, ''];
    }
    const oldPayload = oldEntry.value;
    this.strings.delete(oldSidKey ?? '');

    // Step 2 — SET NX new.
    const ttlSec = Number(ttlSecStr ?? '0');
    const newKey = newSidKey ?? '';
    if (this.strings.has(newKey)) {
      // Restore old, return failure.
      this.strings.set(oldSidKey ?? '', {
        value: oldPayload,
        expiresAtMs: ttlSec > 0 ? now + ttlSec * 1000 : null,
      });
      return [0, ''];
    }
    this.strings.set(newKey, {
      value: newPayloadJson ?? '',
      expiresAtMs: ttlSec > 0 ? now + ttlSec * 1000 : null,
    });

    // Step 3 — index updates (skipped when KEYS slot is empty).
    if (userIndexKey && userIndexKey !== '') {
      await this.sadd(userIndexKey, newSid ?? '');
      await this.srem(userIndexKey, oldSid ?? '');
    }
    if (familyIndexKey && familyIndexKey !== '') {
      await this.sadd(familyIndexKey, newSid ?? '');
    }

    // Step 4 — sid_to_root pointer for the new sid.
    const sidToRootTtl = Number(sidToRootTtlStr ?? '0');
    if (sidToRootNewKey && sidToRootNewKey !== '') {
      this.strings.set(sidToRootNewKey, {
        value: rootSid ?? '',
        expiresAtMs: sidToRootTtl > 0 ? now + sidToRootTtl * 1000 : null,
      });
    }

    return [1, oldPayload];
  }
}

function asRedis(fake: FakeUpstashRedis): Redis {
  return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function inOneHour(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/*  1. Atomic rotate (S2-002)                                          */
/* ================================================================== */

describe('createRedisSessionStore — atomic rotate (S2-002)', () => {
  it('two concurrent rotate() calls produce exactly one ok (and the loser is either unknown or reuse_detected)', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-original', inOneHour());

    // Schedule a small delay so the two evals genuinely
    // interleave; without it, the JS event loop would run
    // them sequentially.
    fake.evalDelayMs = 5;

    const [r1, r2] = await Promise.all([
      store.rotate('sid-original', 'sid-new-A', inOneHour()),
      store.rotate('sid-original', 'sid-new-B', inOneHour()),
    ]);

    // The atomicity guarantee — only ONE rotation may commit.
    // The losing rotation is either:
    //   • `unknown` — its peek already returned null (rare,
    //                 only if the Lua-winning rotation finished
    //                 before the loser's peek even fired); or
    //   • `reuse_detected` — its peek read the original
    //                 payload, but the Lua call lost the
    //                 GETDEL race and the sid_to_root pointer
    //                 (seeded by `create()` for the original
    //                 sid) flags the sid as a known-rotated
    //                 family member.
    // Both losing kinds are safe — the auth service rejects
    // either one with the same opaque 401, with the
    // reuse_detected path additionally tearing down the family
    // (defence in depth against S2-004).
    const okCount = [r1, r2].filter((r) => r.kind === 'ok').length;
    expect(okCount).toBe(1);

    const loser = r1.kind === 'ok' ? r2 : r1;
    expect(['unknown', 'reuse_detected']).toContain(loser.kind);

    // Exactly one of the two new sids must exist; the other
    // must NOT have a per-sid record (the SET NX failure
    // restored the old payload, then the second eval hit GETDEL
    // on a now-empty key and returned {0, ''}).
    const newAExists = await fake.get('auth:sid:sid-new-A');
    const newBExists = await fake.get('auth:sid:sid-new-B');
    const exactlyOne =
      (newAExists !== null && newBExists === null) || (newAExists === null && newBExists !== null);
    expect(exactlyOne).toBe(true);
  });

  it('happy-path rotate returns ok with userId + rootSid', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-1', inOneHour());
    const result = await store.rotate('sid-1', 'sid-2', inOneHour());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.userId).toBe(USER_A);
      // First rotation: root is the original sid.
      expect(result.rootSid).toBe('sid-1');
    }

    // The new sid carries the rootSid forward in its payload.
    const newRaw = await fake.get<string>('auth:sid:sid-2');
    expect(newRaw).not.toBeNull();
    const parsed = JSON.parse(newRaw ?? '{}') as {
      userId: string;
      rootSid: string;
      parentSid: string;
    };
    expect(parsed.userId).toBe(USER_A);
    expect(parsed.rootSid).toBe('sid-1');
    expect(parsed.parentSid).toBe('sid-1');
  });

  it('rotate of a never-existing sid returns unknown (no reuse signal)', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    const result = await store.rotate('sid-forged', 'sid-new', inOneHour());

    expect(result.kind).toBe('unknown');
  });
});

/* ================================================================== */
/*  2. Reuse detection (S2-004)                                        */
/* ================================================================== */

describe('createRedisSessionStore — reuse detection (S2-004)', () => {
  it('replaying a rotated sid surfaces as reuse_detected with the family root', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-1', inOneHour());
    const r1 = await store.rotate('sid-1', 'sid-2', inOneHour());
    expect(r1.kind).toBe('ok');
    const r2 = await store.rotate('sid-2', 'sid-3', inOneHour());
    expect(r2.kind).toBe('ok');

    // Attacker replays sid-1 (legitimate, but already rotated).
    const reuse = await store.rotate('sid-1', 'sid-attacker', inOneHour());

    expect(reuse.kind).toBe('reuse_detected');
    if (reuse.kind === 'reuse_detected') {
      expect(reuse.userId).toBe(USER_A);
      expect(reuse.rootSid).toBe('sid-1');
    }

    // The attacker's new sid must NOT have been written.
    const attackerSid = await fake.get('auth:sid:sid-attacker');
    expect(attackerSid).toBeNull();
  });

  it('revokeFamilyByRootSid clears every descendant + family + sid_to_root pointers', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-1', inOneHour());
    await store.rotate('sid-1', 'sid-2', inOneHour());
    await store.rotate('sid-2', 'sid-3', inOneHour());

    await store.revokeFamilyByRootSid('sid-1');

    // Per-sid records gone.
    expect(await fake.get('auth:sid:sid-1')).toBeNull();
    expect(await fake.get('auth:sid:sid-2')).toBeNull();
    expect(await fake.get('auth:sid:sid-3')).toBeNull();

    // Family set gone.
    expect(await fake.smembers('auth:family:sid-1')).toEqual([]);

    // sid_to_root pointers gone for every sid in the family.
    expect(await fake.get('auth:sid_to_root:sid-1')).toBeNull();
    expect(await fake.get('auth:sid_to_root:sid-2')).toBeNull();
    expect(await fake.get('auth:sid_to_root:sid-3')).toBeNull();

    // User-index set no longer carries the revoked sids.
    const userSids = await fake.smembers(`auth:user:${USER_A}:sids`);
    expect(userSids).toEqual([]);
  });

  it('family revoke is scoped to one user — other users untouched', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-A1', inOneHour());
    await store.create(USER_B, 'sid-B1', inOneHour());
    await store.rotate('sid-B1', 'sid-B2', inOneHour());

    await store.revokeFamilyByRootSid('sid-A1');

    // User B's family is intact.
    expect(await fake.get('auth:sid:sid-B2')).not.toBeNull();
    const userBSids = await fake.smembers(`auth:user:${USER_B}:sids`);
    expect(userBSids).toContain('sid-B2');
  });
});

/* ================================================================== */
/*  3. Backward compatibility                                          */
/* ================================================================== */

describe('createRedisSessionStore — backward compat (Vague 29)', () => {
  it('rotates a legacy payload missing rootSid/parentSid (fallback rootSid = sid)', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    // Hand-craft a pre-Vague-29 payload — only `userId` and
    // `expiresAt`, no family fields.
    const legacyPayload = JSON.stringify({
      userId: USER_A,
      expiresAt: inOneHour().toISOString(),
    });
    await fake.set('auth:sid:legacy', legacyPayload, { ex: 3600 });
    // Legacy didn't seed family / sid_to_root. The reader's
    // fallback should still let a rotation succeed.

    const result = await store.rotate('legacy', 'fresh', inOneHour());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.userId).toBe(USER_A);
      // Fallback: rootSid = the legacy sid itself.
      expect(result.rootSid).toBe('legacy');
    }

    // The new sid's payload now carries the family fields.
    const freshRaw = await fake.get<string>('auth:sid:fresh');
    const parsed = JSON.parse(freshRaw ?? '{}') as {
      rootSid: string;
      parentSid: string;
    };
    expect(parsed.rootSid).toBe('legacy');
    expect(parsed.parentSid).toBe('legacy');
  });

  it('returns unknown (not reuse_detected) when no sid_to_root pointer exists', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    // No create / no rotate — only an attacker hit on a sid the
    // store has never seen. There is no sid_to_root pointer, so
    // the reuse-detection branch must NOT fire.
    const result = await store.rotate('sid-fake', 'sid-x', inOneHour());

    expect(result.kind).toBe('unknown');
  });
});

/* ================================================================== */
/*  4. revoke / revokeAllForUser preserve the family signal           */
/* ================================================================== */

describe('createRedisSessionStore — revoke preserves reuse signal', () => {
  it('revoke() removes the live sid but leaves the family + sid_to_root for forensics', async () => {
    const fake = new FakeUpstashRedis();
    const store = createRedisSessionStore(asRedis(fake));

    await store.create(USER_A, 'sid-1', inOneHour());
    await store.revoke('sid-1');

    // Per-sid record gone.
    expect(await fake.get('auth:sid:sid-1')).toBeNull();
    // User index entry gone.
    const userSids = await fake.smembers(`auth:user:${USER_A}:sids`);
    expect(userSids).toEqual([]);
    // BUT the family + sid_to_root pointer remain so a stolen
    // copy of sid-1 still triggers reuse_detected if rotated.
    expect(await fake.smembers('auth:family:sid-1')).toContain('sid-1');
    expect(await fake.get('auth:sid_to_root:sid-1')).toBe('sid-1');
  });
});

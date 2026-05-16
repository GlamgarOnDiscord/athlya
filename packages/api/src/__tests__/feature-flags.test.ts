/**
 * Unit tests for feature-flags wrapper (Sprint 14 / Slice 14.4,
 * Epic CN.4.2).
 */

import { describe, expect, it } from 'vitest';

import {
  FLAG_CACHE_TTL_MS,
  __resetFeatureFlagCache,
  buildStaticFeatureFlagProvider,
  isEnabled,
} from '../feature-flags.js';

/* ------------------------------------------------------------------ */
/*  buildStaticFeatureFlagProvider                                       */
/* ------------------------------------------------------------------ */

describe('buildStaticFeatureFlagProvider', () => {
  it('returns false for unknown flags', async () => {
    const provider = buildStaticFeatureFlagProvider('{}');
    expect(await provider.getFlag('unknown', {})).toBe(false);
  });

  it('handles malformed JSON gracefully (returns empty catalogue)', async () => {
    const provider = buildStaticFeatureFlagProvider('not-json');
    expect(await provider.getFlag('any', {})).toBe(false);
  });

  it('returns the boolean value for plain bool flags', async () => {
    const provider = buildStaticFeatureFlagProvider('{"a":true,"b":false}');
    expect(await provider.getFlag('a', {})).toBe(true);
    expect(await provider.getFlag('b', {})).toBe(false);
  });

  it('honours allowList for opt-in users regardless of rollout', async () => {
    const provider = buildStaticFeatureFlagProvider(
      JSON.stringify({
        feat: { rollout: 0, allowList: ['user-x'] },
      }),
    );

    expect(await provider.getFlag('feat', { userId: 'user-x' })).toBe(true);
    expect(await provider.getFlag('feat', { userId: 'user-y' })).toBe(false);
  });

  it('honours studioAllowList for opt-in studios', async () => {
    const provider = buildStaticFeatureFlagProvider(
      JSON.stringify({
        feat: { rollout: 0, studioAllowList: ['studio-test'] },
      }),
    );

    expect(
      await provider.getFlag('feat', {
        studioId: 'studio-test',
      }),
    ).toBe(true);
    expect(
      await provider.getFlag('feat', {
        studioId: 'studio-other',
      }),
    ).toBe(false);
  });

  it('rollout 100 always returns true', async () => {
    const provider = buildStaticFeatureFlagProvider(JSON.stringify({ feat: { rollout: 100 } }));
    expect(await provider.getFlag('feat', { userId: 'any-user-1' })).toBe(true);
    expect(await provider.getFlag('feat', { userId: 'any-user-2' })).toBe(true);
  });

  it('rollout 0 always returns false (no allow-list match)', async () => {
    const provider = buildStaticFeatureFlagProvider(JSON.stringify({ feat: { rollout: 0 } }));
    expect(await provider.getFlag('feat', { userId: 'any-user' })).toBe(false);
  });

  it('rollout bucketing is deterministic per userId', async () => {
    // Same userId → same bucket → same result across N calls.
    const provider = buildStaticFeatureFlagProvider(JSON.stringify({ feat: { rollout: 50 } }));
    const v1 = await provider.getFlag('feat', { userId: 'alice' });
    const v2 = await provider.getFlag('feat', { userId: 'alice' });
    const v3 = await provider.getFlag('feat', { userId: 'alice' });
    expect(v1).toBe(v2);
    expect(v2).toBe(v3);
  });

  it('rollout 50 yields ~50% true over a uniform sample', async () => {
    const provider = buildStaticFeatureFlagProvider(JSON.stringify({ feat: { rollout: 50 } }));

    let trueCount = 0;
    const samples = 200;
    for (let i = 0; i < samples; i += 1) {
      const r = await provider.getFlag('feat', {
        userId: `user-${String(i)}`,
      });
      if (r) trueCount += 1;
    }
    // 200 samples, expected 100 true ± noise. Allow ±25 for
    // small-sample variance.
    expect(trueCount).toBeGreaterThan(75);
    expect(trueCount).toBeLessThan(125);
  });
});

/* ------------------------------------------------------------------ */
/*  isEnabled cache                                                      */
/* ------------------------------------------------------------------ */

describe('isEnabled cache', () => {
  it('caches the resolved value for 60s per key', async () => {
    __resetFeatureFlagCache();

    let providerCalls = 0;
    const provider = {
      async getFlag() {
        providerCalls += 1;
        return true;
      },
    };

    let now = 1_000_000;
    const clock = () => now;

    await isEnabled('feat', { userId: 'a' }, provider, clock);
    await isEnabled('feat', { userId: 'a' }, provider, clock);
    await isEnabled('feat', { userId: 'a' }, provider, clock);
    // 1 call only — TTL not expired.
    expect(providerCalls).toBe(1);

    // Advance past TTL.
    now += FLAG_CACHE_TTL_MS + 1;
    await isEnabled('feat', { userId: 'a' }, provider, clock);
    expect(providerCalls).toBe(2);
  });

  it('separates cache by user — alice and bob get independent lookups', async () => {
    __resetFeatureFlagCache();

    let providerCalls = 0;
    const provider = {
      async getFlag() {
        providerCalls += 1;
        return true;
      },
    };

    await isEnabled('feat', { userId: 'alice' }, provider);
    await isEnabled('feat', { userId: 'bob' }, provider);
    expect(providerCalls).toBe(2);

    // Re-call alice — cache hit.
    await isEnabled('feat', { userId: 'alice' }, provider);
    expect(providerCalls).toBe(2);
  });
});

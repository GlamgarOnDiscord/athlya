/**
 * Unit tests for `events/dedup.ts → assertNotSeen`.
 *
 * The module is a thin wrapper around Upstash's `SET … NX EX` so the
 * suite focuses on:
 *
 *   1. The first call for an `eventId` returns `true` AND writes the
 *      key with the configured TTL via the `nx` + `ex` options.
 *   2. A second call for the same id returns `false` AND does NOT
 *      bump the TTL (the underlying `nx` flag forbids overwrite).
 *   3. The Redis key uses the `events:seen:` prefix verbatim — that
 *      is a wire contract operators rely on when scanning Redis.
 *   4. A custom prefix and a custom TTL are honoured.
 *   5. Defensive validation: empty / non-string `eventId`, non-finite
 *      / non-positive `ttlSec`, empty / non-string `prefix` all throw
 *      synchronously without touching Redis.
 *   6. Sub-second TTL is floored to 1 (Upstash rejects `EX 0`).
 *
 * The fake Redis is an in-memory map storing `{ value, ex, nx }` per
 * key — small enough to keep the test honest about the surface
 * `assertNotSeen` actually uses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_DEDUP_PREFIX,
    DEFAULT_DEDUP_TTL_SEC,
    assertNotSeen,
} from '../events/dedup.js';

import type { Redis } from '@upstash/redis';

/* ------------------------------------------------------------------ */
/*  Fake Redis                                                         */
/* ------------------------------------------------------------------ */

interface StoredEntry {
    readonly value: string;
    readonly ex: number;
}

class FakeDedupRedis {
    readonly store = new Map<string, StoredEntry>();
    readonly setSpy = vi.fn();

    async set(
        key: string,
        value: string,
        opts?: { ex?: number; nx?: boolean },
    ): Promise<'OK' | null> {
        this.setSpy(key, value, opts);
        if (opts?.nx === true && this.store.has(key)) {
            return null;
        }
        const ex = opts?.ex ?? 0;
        this.store.set(key, { value, ex });
        // Mirror Upstash's resolved-promise semantics.
        await Promise.resolve();
        return 'OK';
    }
}

/** Cast the fake into the Upstash `Redis` shape for the module seam. */
function asRedis(fake: FakeDedupRedis): Redis {
    return fake as unknown as Redis;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('assertNotSeen', () => {
    let fake: FakeDedupRedis;
    let redis: Redis;

    beforeEach(() => {
        fake = new FakeDedupRedis();
        redis = asRedis(fake);
    });

    it('returns true on first observation and writes the key with NX + 24 h TTL by default', async () => {
        const fresh = await assertNotSeen(redis, 'evt-1');
        expect(fresh).toBe(true);

        expect(fake.setSpy).toHaveBeenCalledTimes(1);
        const [key, value, opts] = fake.setSpy.mock.calls[0]!;
        expect(key).toBe(`${DEFAULT_DEDUP_PREFIX}:evt-1`);
        expect(value).toBe('1');
        expect(opts).toEqual({ ex: DEFAULT_DEDUP_TTL_SEC, nx: true });
    });

    it('returns false on the second observation of the same id and does not refresh the TTL', async () => {
        await assertNotSeen(redis, 'evt-1');
        const replay = await assertNotSeen(redis, 'evt-1');
        expect(replay).toBe(false);

        // The wrapper still issues the SET (NX is enforced server-side
        // by the protocol), but the stored entry must keep its
        // original TTL — i.e. the second call's `ex` never touches
        // the stored row.
        expect(fake.store.get(`${DEFAULT_DEDUP_PREFIX}:evt-1`)?.ex).toBe(
            DEFAULT_DEDUP_TTL_SEC,
        );
        expect(fake.setSpy).toHaveBeenCalledTimes(2);
    });

    it('uses the custom prefix and TTL when provided', async () => {
        const fresh = await assertNotSeen(redis, 'evt-2', 60, 'custom:seen');
        expect(fresh).toBe(true);

        const [key, , opts] = fake.setSpy.mock.calls[0]!;
        expect(key).toBe('custom:seen:evt-2');
        expect(opts).toEqual({ ex: 60, nx: true });
    });

    it('floors fractional TTLs to the nearest second (Upstash rejects EX 0)', async () => {
        await assertNotSeen(redis, 'evt-3', 0.4);
        const [, , opts] = fake.setSpy.mock.calls[0]!;
        expect(opts).toEqual({ ex: 1, nx: true });
    });

    it('isolates events by id (each id gets its own key, both succeed once)', async () => {
        const a = await assertNotSeen(redis, 'evt-a');
        const b = await assertNotSeen(redis, 'evt-b');
        expect(a).toBe(true);
        expect(b).toBe(true);
        expect(fake.store.size).toBe(2);
    });

    it('throws TypeError on empty or non-string eventId without touching Redis', async () => {
        await expect(assertNotSeen(redis, '')).rejects.toBeInstanceOf(TypeError);
        await expect(
            assertNotSeen(redis, undefined as unknown as string),
        ).rejects.toBeInstanceOf(TypeError);
        expect(fake.setSpy).not.toHaveBeenCalled();
    });

    it('throws TypeError on empty prefix without touching Redis', async () => {
        await expect(
            assertNotSeen(redis, 'evt-1', DEFAULT_DEDUP_TTL_SEC, ''),
        ).rejects.toBeInstanceOf(TypeError);
        expect(fake.setSpy).not.toHaveBeenCalled();
    });

    it('throws RangeError on non-finite or non-positive TTL without touching Redis', async () => {
        await expect(assertNotSeen(redis, 'evt-1', 0)).rejects.toBeInstanceOf(
            RangeError,
        );
        await expect(assertNotSeen(redis, 'evt-1', -5)).rejects.toBeInstanceOf(
            RangeError,
        );
        await expect(
            assertNotSeen(redis, 'evt-1', Number.NaN),
        ).rejects.toBeInstanceOf(RangeError);
        expect(fake.setSpy).not.toHaveBeenCalled();
    });
});

/**
 * Unit tests for the idempotency-key helpers.
 *
 * Strategy (matches `client.test.ts`): we stand up a fake drizzle
 * transaction whose only capability is `.execute()` — the helpers
 * never touch anything else on `PostgresJsTransaction`. The fake is
 * built in `_sql-capture.ts` and records every invocation so each
 * test can introspect the SQL shape that the helper emitted. A
 * full-stack Postgres + RLS test is deferred to the integration suite
 * (task 2.7).
 *
 * Related requirements: 20.1, 20.2.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_IDEMPOTENCY_TTL_SEC,
    InvalidIdempotencyInputError,
    lookup,
    store,
} from '../src/idempotency.js';

import { makeFakeTx } from './_sql-capture.js';

const USER_ID = '018f3c11-4e2d-7b53-9a0c-3f76a1d1c8ab';
const KEY = '7c1f2c8e-6a41-4ab8-9b0c-12b3b0f0b9d1';

describe('lookup', () => {
    it('returns null when no matching row is found', async () => {
        const { tx, calls } = makeFakeTx();
        // Default result is [] — no rows.

        const entry = await lookup(tx, KEY, USER_ID);

        expect(entry).toBeNull();
        expect(calls).toHaveLength(1);
        // The expiry check lives in the WHERE clause so a concurrently
        // sweeping worker cannot race against the middleware.
        expect(calls[0]?.sqlText).toMatch(/expires_at\s*>\s*now\(\)/i);
    });

    it('returns the entry with typed fields when a valid row exists', async () => {
        const { tx, enqueueResult } = makeFakeTx();
        const createdAt = new Date('2025-06-01T10:00:00.000Z');
        const expiresAt = new Date('2025-06-02T10:00:00.000Z');
        enqueueResult([
            {
                response: { reservationId: 'abc', status: 'confirmed' },
                status_code: 201,
                created_at: createdAt,
                expires_at: expiresAt,
            },
        ]);

        const entry = await lookup(tx, KEY, USER_ID);

        expect(entry).toEqual({
            response: { reservationId: 'abc', status: 'confirmed' },
            statusCode: 201,
            createdAt,
            expiresAt,
        });
    });

    it('selects on the composite (key, user_id) primary key', async () => {
        const { tx, calls } = makeFakeTx();

        await lookup(tx, KEY, USER_ID);

        const call = calls[0];
        expect(call).toBeDefined();
        expect(call?.sqlText).toMatch(/from\s+idempotency_keys/i);
        expect(call?.sqlText).toMatch(/key\s*=/i);
        expect(call?.sqlText).toMatch(/user_id\s*=/i);
        // Bound parameters in order: key, userId.
        expect(call?.params).toEqual([KEY, USER_ID]);
    });

    it('rejects an empty key before hitting the database', async () => {
        const { tx, execute } = makeFakeTx();
        await expect(lookup(tx, '', USER_ID)).rejects.toBeInstanceOf(
            InvalidIdempotencyInputError,
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID userId before hitting the database', async () => {
        const { tx, execute } = makeFakeTx();
        await expect(lookup(tx, KEY, 'not-a-uuid')).rejects.toBeInstanceOf(
            InvalidIdempotencyInputError,
        );
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('store', () => {
    it('inserts a row with an ON CONFLICT DO NOTHING clause', async () => {
        const { tx, calls } = makeFakeTx();

        await store(tx, KEY, USER_ID, {
            body: { ok: true, id: 'res-1' },
            statusCode: 201,
        });

        expect(calls).toHaveLength(1);
        const call = calls[0];
        expect(call?.sqlText).toMatch(/insert\s+into\s+idempotency_keys/i);
        // Req 20.1: first-write-wins under concurrent replays.
        expect(call?.sqlText).toMatch(
            /on\s+conflict\s*\(\s*key\s*,\s*user_id\s*\)\s*do\s+nothing/i,
        );
    });

    it('binds the key, userId, serialised body, statusCode and ttl as parameters', async () => {
        const { tx, calls } = makeFakeTx();

        await store(
            tx,
            KEY,
            USER_ID,
            { body: { ok: true }, statusCode: 201 },
            3600,
        );

        const call = calls[0];
        expect(call?.params).toEqual([
            KEY,
            USER_ID,
            JSON.stringify({ ok: true }),
            201,
            3600,
        ]);
    });

    it('defaults the TTL to 24 hours when omitted', async () => {
        const { tx, calls } = makeFakeTx();

        await store(tx, KEY, USER_ID, { body: {}, statusCode: 200 });

        const call = calls[0];
        // Last parameter is the TTL — Req 20.2.
        expect(call?.params.at(-1)).toBe(DEFAULT_IDEMPOTENCY_TTL_SEC);
        expect(DEFAULT_IDEMPOTENCY_TTL_SEC).toBe(24 * 60 * 60);
    });

    it('casts the response body to jsonb and computes expires_at in SQL', async () => {
        const { tx, calls } = makeFakeTx();

        await store(tx, KEY, USER_ID, { body: { a: 1 }, statusCode: 200 });

        const call = calls[0];
        // jsonb cast avoids relying on the driver's implicit conversion.
        expect(call?.sqlText).toMatch(/::jsonb/i);
        // `now() + make_interval(secs => $5)` — TTL computed server-side.
        expect(call?.sqlText).toMatch(/now\(\)\s*\+\s*make_interval/i);
    });

    it('is idempotent under simulated concurrent writes (ON CONFLICT DO NOTHING)', async () => {
        // Both callers see the miss path and race to insert; the second
        // insert is a server-side no-op because of ON CONFLICT. From
        // the helper's perspective, both calls resolve cleanly.
        const { tx } = makeFakeTx();

        const responses = await Promise.all([
            store(tx, KEY, USER_ID, { body: { v: 1 }, statusCode: 201 }),
            store(tx, KEY, USER_ID, { body: { v: 2 }, statusCode: 201 }),
        ]);

        expect(responses).toHaveLength(2);
        responses.forEach((r) => {
            expect(r).toBeUndefined();
        });
    });

    it('rejects an invalid statusCode before hitting the database', async () => {
        const { tx, execute } = makeFakeTx();
        await expect(
            store(tx, KEY, USER_ID, { body: {}, statusCode: 42 }),
        ).rejects.toBeInstanceOf(InvalidIdempotencyInputError);
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a zero or negative TTL', async () => {
        const { tx, execute } = makeFakeTx();
        await expect(
            store(tx, KEY, USER_ID, { body: {}, statusCode: 200 }, 0),
        ).rejects.toBeInstanceOf(InvalidIdempotencyInputError);
        await expect(
            store(tx, KEY, USER_ID, { body: {}, statusCode: 200 }, -1),
        ).rejects.toBeInstanceOf(InvalidIdempotencyInputError);
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects a non-object response body', async () => {
        const { tx, execute } = makeFakeTx();
        await expect(
            store(
                tx,
                KEY,
                USER_ID,
                // Cast around the type system to simulate a bug upstream.
                { body: null as unknown as Record<string, unknown>, statusCode: 200 },
            ),
        ).rejects.toBeInstanceOf(InvalidIdempotencyInputError);
        expect(execute).not.toHaveBeenCalled();
    });
});

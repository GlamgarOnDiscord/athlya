/**
 * Unit tests for `@athlya/auth/qr`.
 *
 * These exercise every branch of Requirement 11 that the QR module
 * owns:
 *
 *   - 11.1 — `generateAccessQR` stamps `sub`, `studio`, `kind='checkin'`,
 *     `iat`, `exp = iat + 120`, and a fresh `jti`.
 *   - 11.2 — `verifyAccessQR` runs signature, `kind`, `studio` and
 *     time-window checks in the right order.
 *   - 11.3 — every verification failure surfaces as
 *     {@link InvalidQRTokenError} with `code = 'invalid_token'`.
 *   - 11.4 — on success, the `jti` is recorded in the replay store.
 *   - 11.5 — on replay, verification throws
 *     {@link QRReplayError} with `code = 'replay'`.
 *
 * The signing key is minted once per suite (RSA 2048 generation costs
 * ~100 ms). An in-memory `Map`-backed {@link ReplayStore} keeps the
 * tests hermetic — a Redis-backed integration test lives in the
 * reservations service.
 *
 * Related requirements: 11.1, 11.2, 11.3, 11.4, 11.5.
 */

import { generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { currentJwks, publicJwkOf } from '../jwt.js';
import {
    InvalidQRTokenError,
    QR_TTL_SEC,
    QRReplayError,
    generateAccessQR,
    verifyAccessQR,
} from '../qr.js';

import type { Jwks, SigningKey } from '../jwt.js';
import type { ReplayStore } from '../qr.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDIO_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_STUDIO_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Minimal in-memory replay store. Mirrors the Redis adapter's
 * semantics: `has` is pure lookup; `add` records the jti. We also
 * expose the underlying map so individual tests can assert the store
 * was mutated.
 */
class InMemoryReplayStore implements ReplayStore {
    public readonly entries = new Map<string, { ttlSec: number }>();

    public has(jti: string): Promise<boolean> {
        return Promise.resolve(this.entries.has(jti));
    }

    public add(jti: string, ttlSec: number): Promise<void> {
        if (!this.entries.has(jti)) {
            this.entries.set(jti, { ttlSec });
        }
        return Promise.resolve();
    }
}

async function mintSigningKey(kid: string): Promise<SigningKey> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', {
        modulusLength: 2048,
        extractable: true,
    });
    return { kid, privateKey, publicKey };
}

async function jwksOf(...keys: SigningKey[]): Promise<Jwks> {
    const entries = await Promise.all(
        keys.map(async (k) => ({ kid: k.kid, publicKey: await publicJwkOf(k) })),
    );
    return currentJwks(entries);
}

function decodePayload(token: string): Record<string, unknown> {
    const parts = token.split('.');
    const raw = parts[1] ?? '';
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<
        string,
        unknown
    >;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let signingKey: SigningKey;
let otherKey: SigningKey;
let jwks: Jwks;

beforeAll(async () => {
    signingKey = await mintSigningKey('qr-key');
    otherKey = await mintSigningKey('other-key');
    jwks = await jwksOf(signingKey);
});

let replay: InMemoryReplayStore;

beforeEach(() => {
    replay = new InMemoryReplayStore();
});

// ---------------------------------------------------------------------------
// generateAccessQR
// ---------------------------------------------------------------------------

describe('generateAccessQR', () => {
    it('stamps sub, studio, kind, iat, exp=iat+120 and a jti (Req 11.1)', async () => {
        const frozenNow = 1_700_000_000;
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => frozenNow,
            jti: () => 'fixed-jti',
        });

        const payload = decodePayload(token);
        expect(payload['sub']).toBe(USER_ID);
        expect(payload['studio']).toBe(STUDIO_ID);
        expect(payload['kind']).toBe('checkin');
        expect(payload['iat']).toBe(frozenNow);
        expect(payload['exp']).toBe(frozenNow + QR_TTL_SEC);
        expect(payload['jti']).toBe('fixed-jti');
    });

    it('mints a fresh jti on each call', async () => {
        const t1 = await generateAccessQR(USER_ID, STUDIO_ID, { signingKey });
        const t2 = await generateAccessQR(USER_ID, STUDIO_ID, { signingKey });
        expect(decodePayload(t1)['jti']).not.toBe(decodePayload(t2)['jti']);
    });

    it('rejects empty userId or studioId', async () => {
        await expect(
            generateAccessQR('', STUDIO_ID, { signingKey }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
            generateAccessQR(USER_ID, '', { signingKey }),
        ).rejects.toBeInstanceOf(TypeError);
    });
});

// ---------------------------------------------------------------------------
// verifyAccessQR — happy path
// ---------------------------------------------------------------------------

describe('verifyAccessQR happy path', () => {
    it('accepts a valid token and returns userId/studioId/jti', async () => {
        const frozenNow = 1_700_000_000;
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => frozenNow,
            jti: () => 'jti-happy',
        });

        const result = await verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => frozenNow + 1,
        });

        expect(result).toEqual({
            userId: USER_ID,
            studioId: STUDIO_ID,
            jti: 'jti-happy',
        });
    });

    it('records the jti in the replay store with a TTL <= 120 s (Req 11.4)', async () => {
        const frozenNow = 1_700_000_000;
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => frozenNow,
            jti: () => 'jti-record',
        });

        await verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => frozenNow + 30, // 90 s of token life remaining
        });

        expect(replay.entries.has('jti-record')).toBe(true);
        const entry = replay.entries.get('jti-record');
        expect(entry?.ttlSec).toBe(QR_TTL_SEC - 30);
    });
});

// ---------------------------------------------------------------------------
// verifyAccessQR — failure modes (Req 11.3)
// ---------------------------------------------------------------------------

describe('verifyAccessQR failure modes', () => {
    it('rejects a token scoped to a different studio with invalid_token', async () => {
        const token = await generateAccessQR(USER_ID, OTHER_STUDIO_ID, {
            signingKey,
        });

        const promise = verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
        });

        await expect(promise).rejects.toBeInstanceOf(InvalidQRTokenError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_token' });
        // Step 3 failed → jti must NOT have been recorded.
        expect(replay.entries.size).toBe(0);
    });

    it('rejects a tampered token with invalid_token', async () => {
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
        });
        const parts = token.split('.');
        expect(parts).toHaveLength(3);
        const [header, payload, signature] = parts as [string, string, string];

        // Flip one char inside the payload segment while staying in the
        // base64url alphabet, so the JWT is still structurally parseable
        // but the signature no longer matches.
        const tamperIndex = Math.floor(payload.length / 2);
        const original = payload[tamperIndex] ?? 'A';
        const replacement = original === 'A' ? 'B' : 'A';
        const tamperedPayload =
            payload.slice(0, tamperIndex) +
            replacement +
            payload.slice(tamperIndex + 1);
        const tampered = [header, tamperedPayload, signature].join('.');

        const promise = verifyAccessQR(tampered, STUDIO_ID, {
            jwks,
            replayStore: replay,
        });

        await expect(promise).rejects.toBeInstanceOf(InvalidQRTokenError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_token' });
        expect(replay.entries.size).toBe(0);
    });

    it('rejects an expired token with invalid_token', async () => {
        const frozenNow = 1_700_000_000;
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => frozenNow,
        });

        // Push verification time well past exp (= iat + 120).
        const promise = verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => frozenNow + QR_TTL_SEC + 10,
        });

        await expect(promise).rejects.toBeInstanceOf(InvalidQRTokenError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_token' });
        expect(replay.entries.size).toBe(0);
    });

    it('rejects a token signed by an unknown key with invalid_token', async () => {
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey: otherKey,
        });

        const promise = verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
        });

        await expect(promise).rejects.toBeInstanceOf(InvalidQRTokenError);
        await expect(promise).rejects.toMatchObject({ code: 'invalid_token' });
        expect(replay.entries.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// verifyAccessQR — replay (Req 11.5)
// ---------------------------------------------------------------------------

describe('verifyAccessQR replay detection', () => {
    it('first verify succeeds and records jti; second verify throws QRReplayError', async () => {
        const frozenNow = 1_700_000_000;
        const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => frozenNow,
            jti: () => 'jti-replay',
        });

        // First presentation succeeds.
        const first = await verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => frozenNow + 1,
        });
        expect(first.jti).toBe('jti-replay');
        expect(replay.entries.has('jti-replay')).toBe(true);

        // Second presentation of the same token → replay.
        const promise = verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => frozenNow + 2,
        });

        await expect(promise).rejects.toBeInstanceOf(QRReplayError);
        await expect(promise).rejects.toMatchObject({ code: 'replay' });
    });
});

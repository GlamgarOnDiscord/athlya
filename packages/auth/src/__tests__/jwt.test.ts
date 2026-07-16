/**
 * Unit tests for `@athlya/auth/jwt`.
 *
 * These exercise the three guarantees task 3.2 requires:
 *   1. Sign + verify round-trip (access and refresh tokens).
 *   2. Verification rejects expired tokens and tokens with a tampered
 *      payload.
 *   3. Key rotation: during the grace period the JWKS contains both
 *      keys and tokens signed by the old key still verify; after the
 *      grace period the old key is dropped and its tokens are
 *      rejected.
 *
 * We generate RSA 2048-bit key pairs in `beforeAll` rather than in
 * every test to keep the suite fast; jose's `generateKeyPair` burns
 * ~50-200 ms per key in Node.
 *
 * Related requirements: 2.1, 2.2, 25.5.
 */

import { errors, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ACCESS_TTL_SEC,
  DEFAULT_REFRESH_TTL_SEC,
  currentJwks,
  publicJwkOf,
  rotateKeys,
  rotateKeysAsync,
  signAccess,
  signRefresh,
  verify,
} from '../jwt.js';

import type { AccessClaims, RefreshClaims, SigningKey } from '../jwt.js';

const ACCESS_CLAIMS: AccessClaims = {
  sub: '11111111-1111-4111-8111-111111111111',
  studio: '22222222-2222-4222-8222-222222222222',
  role: 'member',
  cv: 1,
};

const REFRESH_CLAIMS: RefreshClaims = {
  sub: ACCESS_CLAIMS.sub,
  sid: '33333333-3333-4333-8333-333333333333',
};

async function mintSigningKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  return { kid, privateKey, publicKey };
}

async function jwksOf(...keys: SigningKey[]) {
  const entries = await Promise.all(
    keys.map(async (k) => ({ kid: k.kid, publicKey: await publicJwkOf(k) })),
  );
  return currentJwks(entries);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let keyA: SigningKey;
let keyB: SigningKey;

beforeAll(async () => {
  keyA = await mintSigningKey('kid-A');
  keyB = await mintSigningKey('kid-B');
});

// ---------------------------------------------------------------------------
// Sign + verify round-trip
// ---------------------------------------------------------------------------

describe('signAccess / verify', () => {
  it('round-trips the payload and stamps iat/exp (Req 2.1)', async () => {
    const frozenNow = 1_700_000_000; // seconds since epoch
    const token = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      now: () => frozenNow,
    });

    const jwks = await jwksOf(keyA);
    const payload = await verify<AccessClaims>(token, jwks, {
      currentDate: new Date(frozenNow * 1000 + 1000),
    });

    expect(payload.sub).toBe(ACCESS_CLAIMS.sub);
    expect(payload.studio).toBe(ACCESS_CLAIMS.studio);
    expect(payload.role).toBe(ACCESS_CLAIMS.role);
    expect(payload.iat).toBe(frozenNow);
    expect(payload.exp).toBe(frozenNow + DEFAULT_ACCESS_TTL_SEC);
  });

  it('embeds the signing key kid in the JWS header so JWKS resolution works', async () => {
    const token = await signAccess(ACCESS_CLAIMS, { signingKey: keyA });
    const [headerB64] = token.split('.');
    // base64url → base64
    const header = JSON.parse(
      Buffer.from((headerB64 ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
        'utf8',
      ),
    ) as { alg: string; typ: string; kid: string };
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe(keyA.kid);
  });

  it('honours the ttlSec override', async () => {
    const frozenNow = 1_700_000_000;
    const token = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      ttlSec: 60,
      now: () => frozenNow,
    });
    const jwks = await jwksOf(keyA);
    const payload = await verify<AccessClaims>(token, jwks, {
      currentDate: new Date(frozenNow * 1000),
    });
    expect(payload.exp).toBe(frozenNow + 60);
  });

  it('honours issuer and audience when set on both sides', async () => {
    const frozenNow = 1_700_000_000;
    const token = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      issuer: 'https://auth.athlya.app',
      audience: 'athlya-api',
      now: () => frozenNow,
    });
    const jwks = await jwksOf(keyA);
    const payload = await verify(token, jwks, {
      issuer: 'https://auth.athlya.app',
      audience: 'athlya-api',
      currentDate: new Date(frozenNow * 1000),
    });
    expect(payload.iss).toBe('https://auth.athlya.app');
    expect(payload.aud).toBe('athlya-api');
  });

  it('rejects invalid claims at sign time', async () => {
    await expect(
      signAccess({ ...ACCESS_CLAIMS, sub: '' }, { signingKey: keyA }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(signAccess(ACCESS_CLAIMS, { signingKey: keyA, ttlSec: 0 })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      signAccess(ACCESS_CLAIMS, { signingKey: keyA, ttlSec: -1 }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('signRefresh / verify', () => {
  it('round-trips and defaults the TTL to 30 days (Req 2.2)', async () => {
    const frozenNow = 1_700_000_000;
    const token = await signRefresh(REFRESH_CLAIMS, {
      signingKey: keyA,
      now: () => frozenNow,
    });
    const jwks = await jwksOf(keyA);
    const payload = await verify<RefreshClaims>(token, jwks, {
      currentDate: new Date(frozenNow * 1000),
    });
    expect(payload.sub).toBe(REFRESH_CLAIMS.sub);
    expect(payload.sid).toBe(REFRESH_CLAIMS.sid);
    expect(payload.exp).toBe(frozenNow + DEFAULT_REFRESH_TTL_SEC);
  });

  it('rejects empty sub or sid', async () => {
    await expect(
      signRefresh({ ...REFRESH_CLAIMS, sub: '' }, { signingKey: keyA }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      signRefresh({ ...REFRESH_CLAIMS, sid: '' }, { signingKey: keyA }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('verify failure modes', () => {
  it('rejects an expired token with JWTExpired', async () => {
    const frozenNow = 1_700_000_000;
    const token = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      ttlSec: 60,
      now: () => frozenNow,
    });
    const jwks = await jwksOf(keyA);

    // currentDate 2 minutes after issuance → expired.
    await expect(
      verify(token, jwks, {
        currentDate: new Date((frozenNow + 120) * 1000),
      }),
    ).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it('rejects a tampered payload with JWSSignatureVerificationFailed', async () => {
    const token = await signAccess(ACCESS_CLAIMS, { signingKey: keyA });
    const jwks = await jwksOf(keyA);

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const [header, payload, signature] = parts as [string, string, string];

    // Flip one character inside the payload segment. We pick a
    // character that lives in the base64url alphabet so the token
    // remains structurally parseable — the signature check is what
    // must fail, not the base64 decode.
    const tamperIndex = Math.floor(payload.length / 2);
    const original = payload[tamperIndex] ?? 'A';
    const replacement = original === 'A' ? 'B' : 'A';
    const tamperedPayload =
      payload.slice(0, tamperIndex) + replacement + payload.slice(tamperIndex + 1);
    const tampered = [header, tamperedPayload, signature].join('.');

    await expect(verify(tampered, jwks)).rejects.toBeInstanceOf(
      errors.JWSSignatureVerificationFailed,
    );
  });

  it('rejects a token signed by an unknown key (kid not in JWKS)', async () => {
    const token = await signAccess(ACCESS_CLAIMS, { signingKey: keyA });
    const jwksWithoutA = await jwksOf(keyB);

    await expect(verify(token, jwksWithoutA)).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// JWKS publishing + key rotation
// ---------------------------------------------------------------------------

describe('currentJwks', () => {
  it('publishes every key whose notAfter is in the future', async () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 60_000);

    const jwkA = await publicJwkOf(keyA);
    const jwkB = await publicJwkOf(keyB);

    const jwks = currentJwks(
      [
        { kid: keyA.kid, publicKey: jwkA }, // no notAfter → keep
        { kid: keyB.kid, publicKey: jwkB, notAfter: future }, // future → keep
        { kid: 'stale', publicKey: jwkA, notAfter: past }, // past → drop
      ],
      now,
    );

    const kids = jwks.keys.map((k) => k.kid);
    expect(kids).toEqual([keyA.kid, keyB.kid]);
    // canonical fields stamped
    for (const jwk of jwks.keys) {
      expect(jwk.alg).toBe('RS256');
      expect(jwk.use).toBe('sig');
    }
  });
});

describe('rotateKeysAsync + verify', () => {
  it('keeps verification working during the grace period (Req 25.5)', async () => {
    const rotatedAt = new Date('2025-01-01T00:00:00Z');
    const graceSec = 3600;

    // Sign a token with the OLD key at rotation time with a TTL
    // that straddles the grace window.
    const oldToken = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      ttlSec: graceSec + 600,
      now: () => Math.floor(rotatedAt.getTime() / 1000),
    });

    const rotation = await rotateKeysAsync(keyA, keyB, graceSec, rotatedAt);

    // During the grace period the JWKS must contain both keys.
    expect(rotation.jwks.keys).toHaveLength(2);
    const kids = rotation.jwks.keys.map((k) => k.kid).sort();
    expect(kids).toEqual([keyA.kid, keyB.kid].sort());

    // A token signed with the OLD key verifies against the grace
    // JWKS half an hour after rotation.
    const midGrace = new Date(rotatedAt.getTime() + (graceSec / 2) * 1000);
    const payload = await verify<AccessClaims>(oldToken, rotation.jwks, {
      currentDate: midGrace,
    });
    expect(payload.sub).toBe(ACCESS_CLAIMS.sub);
  });

  it('drops the old key from the JWKS after the grace period', async () => {
    const rotatedAt = new Date('2025-01-01T00:00:00Z');
    const graceSec = 3600;

    const oldToken = await signAccess(ACCESS_CLAIMS, {
      signingKey: keyA,
      // Generous TTL so the token itself has not expired — the
      // rejection must come from the JWKS not containing kid-A.
      ttlSec: graceSec * 10,
      now: () => Math.floor(rotatedAt.getTime() / 1000),
    });

    const rotation = await rotateKeysAsync(keyA, keyB, graceSec, rotatedAt);

    // Rebuild the JWKS 1 second *after* the grace window closed —
    // this is how currentJwks would be called on each request.
    const afterGrace = new Date(rotation.graceExpiresAt.getTime() + 1000);
    const publishedEntries = await Promise.all(
      [rotation.current, rotation.previous].map(async (k) => ({
        kid: k.kid,
        publicKey: await publicJwkOf(k),
        ...(k.notAfter !== undefined ? { notAfter: k.notAfter } : {}),
      })),
    );
    const postGraceJwks = currentJwks(publishedEntries, afterGrace);

    // Only the new key is left.
    expect(postGraceJwks.keys).toHaveLength(1);
    expect(postGraceJwks.keys[0]?.kid).toBe(keyB.kid);

    // And the old token is rejected by verify because no JWKS entry
    // matches its kid.
    await expect(
      verify(oldToken, postGraceJwks, { currentDate: afterGrace }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects a rotation using the same kid on both sides', () => {
    expect(() => rotateKeys(keyA, keyA, 3600, new Date())).toThrow(TypeError);
  });
});

/**
 * JWT signing/verification — property tests.
 *
 * **Validates: Requirements 2.1, 2.2**
 *
 * Two complementary invariants covering the non-QR JWT module (signAccess /
 * signRefresh / verify) that the QR property test already validates for the
 * check-in path:
 *
 *   - **P-JWT.1 — Sign/verify round-trip identity.** For any valid
 *     `(sub, studio, role)` triple and any TTL in a sensible range,
 *     `verify(signAccess(claims, key), jwks)` returns a payload where the
 *     three claims equal the inputs and `exp - iat === ttl`. This is the
 *     strongest practical guarantee that the signer and verifier agree on
 *     both the header shape (`alg = 'RS256'`, `kid`) and the payload
 *     structure across the `jose` API surface we rely on.
 *
 *   - **P-JWT.2 — Refresh tokens are unforgeable.** Signing a refresh
 *     token with key A and trying to verify it against a JWKS that lists
 *     only key B always fails, regardless of `(sub, sid)` input. This pins
 *     down the cryptographic property that a refresh token from a
 *     compromised issuer environment cannot be used against a different
 *     deployment — a Worker isolate that sees a rotated-out kid must
 *     reject the token.
 *
 * Mechanics: two RSA 2048 key pairs are minted once in `beforeAll`. Every
 * sample uses the frozen clock `FROZEN_NOW` — property tests are about the
 * structural behaviour of the module, not wall-clock races. `numRuns: 50`
 * keeps the suite well under the 30 s test timeout even on CI.
 */

import fc from 'fast-check';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { currentJwks, publicJwkOf, signAccess, signRefresh, verify } from '../../src/jwt.js';

import type { AccessClaims, Jwks, RefreshClaims, SigningKey } from '../../src/jwt.js';

const RUN_OPTS = { numRuns: 50, seed: 0x71c0de } as const;

/** Frozen "now" in seconds — every sign/verify runs at this instant. */
const FROZEN_NOW = 1_700_000_000;

let keyA: SigningKey;
let keyB: SigningKey;
let jwksA: Jwks;
let jwksB: Jwks;

beforeAll(async () => {
  const [{ privateKey: pa, publicKey: ua }, { privateKey: pb, publicKey: ub }] = await Promise.all([
    generateKeyPair('RS256', { modulusLength: 2048, extractable: true }),
    generateKeyPair('RS256', { modulusLength: 2048, extractable: true }),
  ]);
  keyA = { kid: 'jwt-prop-key-a', privateKey: pa, publicKey: ua };
  keyB = { kid: 'jwt-prop-key-b', privateKey: pb, publicKey: ub };
  const [jwkA, jwkB] = await Promise.all([publicJwkOf(keyA), publicJwkOf(keyB)]);
  jwksA = currentJwks([{ kid: keyA.kid, publicKey: jwkA }]);
  jwksB = currentJwks([{ kid: keyB.kid, publicKey: jwkB }]);
});

/**
 * UUID arbitrary — produces values that match `UserIdSchema` / `StudioIdSchema`.
 * fast-check's built-in `fc.uuid()` yields random UUID versions; for our
 * claim space any valid UUID is fine.
 */
const uuidArb = fc.uuid();

const roleArb = fc.constantFrom<AccessClaims['role']>('member', 'coach', 'admin');

/**
 * TTL in seconds — bounded to `[60, 3600]` so expiry stays strictly after
 * iat (prevents the property from getting a 0-TTL edge case that jose
 * would reject at sign time).
 */
const ttlArb = fc.integer({ min: 60, max: 3_600 });

describe('Property P-JWT.1 — signAccess/verify round-trip preserves claims and TTL', () => {
  it('verify(signAccess(claims, keyA), jwksA) = claims for any valid input', async () => {
    await fc.assert(
      fc.asyncProperty(uuidArb, uuidArb, roleArb, ttlArb, async (sub, studio, role, ttlSec) => {
        const claims: AccessClaims = { sub, studio, role, cv: 1 };
        const token = await signAccess(claims, {
          signingKey: keyA,
          ttlSec,
          now: () => FROZEN_NOW,
        });
        const payload = await verify<AccessClaims & { iat: number; exp: number }>(token, jwksA, {
          currentDate: new Date(FROZEN_NOW * 1000),
        });
        // Core claims flow through unchanged.
        expect(payload.sub).toBe(sub);
        expect(payload.studio).toBe(studio);
        expect(payload.role).toBe(role);
        // `jose` sets iat/exp in seconds; the delta must equal
        // the TTL we asked for.
        expect(payload.exp - payload.iat).toBe(ttlSec);
        expect(payload.iat).toBe(FROZEN_NOW);
      }),
      RUN_OPTS,
    );
  });
});

describe('Property P-JWT.2 — refresh tokens are unforgeable across deployments', () => {
  it('a refresh token signed with keyA never verifies against a JWKS listing only keyB', async () => {
    await fc.assert(
      fc.asyncProperty(uuidArb, uuidArb, async (sub, sid) => {
        const claims: RefreshClaims = { sub, sid };
        const token = await signRefresh(claims, {
          signingKey: keyA,
          ttlSec: 60,
          now: () => FROZEN_NOW,
        });
        // verify should reject because the kid in the token
        // header (`keyA.kid`) is absent from jwksB.
        await expect(
          verify(token, jwksB, {
            currentDate: new Date(FROZEN_NOW * 1000),
          }),
        ).rejects.toBeTruthy();
      }),
      RUN_OPTS,
    );
  });
});

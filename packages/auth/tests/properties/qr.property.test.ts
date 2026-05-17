/**
 * QR check-in token — Property 6: JWT non-forgeability and non-replayability.
 *
 * **Validates: Requirements 11.2, 11.3, 11.5**
 *
 * The QR module (`src/qr.ts`) is the only code path that stamps and then
 * accepts a bearer token as proof that a specific member may check in at
 * a specific studio. Requirement 11.2 mandates that verification check
 * signature, `kind`, `studio` and time window before any database read;
 * Requirement 11.3 maps every such failure to the stable error code
 * `invalid_token`; Requirement 11.5 adds a replay guard keyed on `jti`.
 *
 * These properties pin the four guarantees that cannot be proven by a
 * handful of examples because the adversary has an unbounded input
 * space:
 *
 *   - **P6.1 — Forgery.** Any single-character mutation of a valid token
 *     makes verification reject with `invalid_token`. The signature is
 *     computed over the ASCII string `header.payload`, so every char
 *     change — inside header, payload, signature or a `.` separator —
 *     must invalidate the token.
 *   - **P6.2 — Expiry.** For any elapsed time strictly greater than
 *     `QR_TTL_SEC`, verification rejects with `invalid_token`
 *     (Requirement 11.2's `iat ≤ now ≤ exp` window).
 *   - **P6.3 — Replay.** For any valid `jti`, the first verify succeeds
 *     and every subsequent verify against the same replay store throws
 *     `QRReplayError` with code `replay` (Requirement 11.5).
 *   - **P6.4 — Wrong studio.** A token whose `studio` claim differs
 *     from the expected studio id is rejected with `invalid_token`
 *     regardless of how the two UUIDs relate.
 *
 * Mechanics:
 *   - A single RSA 2048 key pair is minted in `beforeAll`; jose's
 *     `generateKeyPair` costs ~100 ms, and we cannot amortise that
 *     across property runs any other way.
 *   - Every fast-check sample uses a **fresh** `Map`-backed replay
 *     store, matching the task's "In-memory `ReplayStore` via a fresh
 *     Map per run" requirement. State never leaks between samples,
 *     which is what makes the `numRuns: 100, seed: 0x3E5A4F` run
 *     reproducible.
 *   - `numRuns: 100` and the fixed seed keep the whole file under the
 *     30 s testTimeout declared in `vitest.config.ts`.
 */

import fc from 'fast-check';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { currentJwks, publicJwkOf } from '../../src/jwt.js';
import {
  InvalidQRTokenError,
  QR_TTL_SEC,
  QRReplayError,
  generateAccessQR,
  verifyAccessQR,
} from '../../src/qr.js';

import type { Jwks, SigningKey } from '../../src/jwt.js';
import type { ReplayStore } from '../../src/qr.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Reproducibility seed — stable unless bumped on purpose. */
const RUN_OPTS = { numRuns: 100, seed: 0x3e5a4f } as const;

const USER_ID = '11111111-1111-4111-8111-111111111111';
const STUDIO_ID = '22222222-2222-4222-8222-222222222222';

/** Frozen "now" used for every sign/verify — property tests are about
 *  the *structural* behaviour of the module, not wall-clock races. */
const FROZEN_NOW = 1_700_000_000;

/**
 * Base64url alphabet plus the `.` separator. Every character in a
 * compact JWS comes from this 65-char set; picking a replacement from
 * the same set (with a non-zero rotation) guarantees
 *   (a) the replacement is a different character, and
 *   (b) the tampered token still looks like a JWS to naive parsers,
 *       which stresses the `jose` verification path rather than an
 *       early structural rejection.
 */
const JWS_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';

let signingKey: SigningKey;
let jwks: Jwks;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  signingKey = { kid: 'qr-prop-key', privateKey, publicKey };
  const jwk = await publicJwkOf(signingKey);
  jwks = currentJwks([{ kid: signingKey.kid, publicKey: jwk }]);
});

/**
 * Minimal in-memory `ReplayStore`. A fresh instance is created for
 * each property sample so `jti` state never leaks between runs — which
 * is what keeps the seed reproducible.
 */
function makeReplay(): ReplayStore {
  const seen = new Map<string, number>();
  return {
    has(jti) {
      return Promise.resolve(seen.has(jti));
    },
    add(jti, ttlSec) {
      if (!seen.has(jti)) seen.set(jti, ttlSec);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// P6.1 — Forgery: any single-character mutation is rejected
// ---------------------------------------------------------------------------

describe('Property 6.1 — forgery (single-character mutation → invalid_token)', () => {
  it('rejects every one-char mutation of a valid token with InvalidQRTokenError', async () => {
    // One canonical token for the whole property run. We want to
    // exercise many different tampers against a fixed valid
    // baseline; regenerating the token per sample would add cost
    // without increasing the semantic coverage (a tamper at index
    // 42 of *any* token should still fail).
    const validToken = await generateAccessQR(USER_ID, STUDIO_ID, {
      signingKey,
      now: () => FROZEN_NOW,
      jti: () => 'jti-forge-baseline',
    });

    await fc.assert(
      fc.asyncProperty(
        // Index of the char to mutate.
        fc.nat({ max: validToken.length - 1 }),
        // Rotation in the alphabet; strictly positive so the
        // replacement is always distinct from the original.
        fc.integer({ min: 1, max: JWS_ALPHABET.length - 1 }),
        async (index, delta) => {
          const original = validToken.charAt(index);
          const originalIdx = JWS_ALPHABET.indexOf(original);
          // The baseline token is pure base64url + '.', so every
          // char lives in our alphabet. Guard anyway so a future
          // jose version that emits padding-style output fails
          // loudly rather than silently skipping.
          if (originalIdx < 0) {
            throw new Error(`Unexpected non-alphabet char '${original}' at index ${index}`);
          }
          const replacementIdx = (originalIdx + delta) % JWS_ALPHABET.length;
          const replacement = JWS_ALPHABET.charAt(replacementIdx);
          // With delta ∈ [1, 64] on a 65-sized alphabet the
          // rotation is never the identity, so replacement
          // differs from original by construction.
          const tampered = validToken.slice(0, index) + replacement + validToken.slice(index + 1);

          // A fresh replay store so any accidental successful
          // verify would not pollute neighbouring samples.
          const replay = makeReplay();
          try {
            await verifyAccessQR(tampered, STUDIO_ID, {
              jwks,
              replayStore: replay,
              now: () => FROZEN_NOW + 1,
            });
            // Reaching here means the tamper was accepted —
            // a forgery counter-example. Fail loudly.
            return false;
          } catch (err) {
            // The QR module surfaces every signature /
            // structure / payload failure as
            // InvalidQRTokenError with code 'invalid_token'
            // (Req 11.3).
            return err instanceof InvalidQRTokenError && err.code === 'invalid_token';
          }
        },
      ),
      RUN_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// P6.2 — Expiry: any verify time > iat + QR_TTL_SEC is rejected
// ---------------------------------------------------------------------------

describe('Property 6.2 — expiry (now > exp → invalid_token)', () => {
  it('rejects tokens verified past exp with InvalidQRTokenError', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any elapsed time strictly greater than QR_TTL_SEC.
        // Upper bound 3600 keeps the numerical range tight so
        // shrinking lands on a small, legible counter-example.
        fc.integer({ min: QR_TTL_SEC + 1, max: 3600 }),
        async (elapsedSec) => {
          const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => FROZEN_NOW,
          });
          const replay = makeReplay();
          try {
            await verifyAccessQR(token, STUDIO_ID, {
              jwks,
              replayStore: replay,
              now: () => FROZEN_NOW + elapsedSec,
            });
            return false;
          } catch (err) {
            return err instanceof InvalidQRTokenError && err.code === 'invalid_token';
          }
        },
      ),
      RUN_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// P6.3 — Replay: second verify with the same jti throws QRReplayError
// ---------------------------------------------------------------------------

describe('Property 6.3 — replay (second verify with same jti → replay)', () => {
  it('first verify succeeds, every retry on the same store throws QRReplayError', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Non-empty jti strings; the QR module accepts any
        // string-valued jti, so we don't constrain to UUID
        // shape — we want fast-check to probe the boundary.
        fc.string({ minLength: 1, maxLength: 64 }),
        async (jti) => {
          const token = await generateAccessQR(USER_ID, STUDIO_ID, {
            signingKey,
            now: () => FROZEN_NOW,
            jti: () => jti,
          });

          // Fresh store per run so each sample is independent.
          const replay = makeReplay();

          // First presentation: must succeed and record the jti.
          const first = await verifyAccessQR(token, STUDIO_ID, {
            jwks,
            replayStore: replay,
            now: () => FROZEN_NOW + 1,
          });
          if (first.jti !== jti) return false;

          // Second presentation against the SAME replay store:
          // must fail with QRReplayError / code 'replay'.
          try {
            await verifyAccessQR(token, STUDIO_ID, {
              jwks,
              replayStore: replay,
              now: () => FROZEN_NOW + 2,
            });
            return false;
          } catch (err) {
            return err instanceof QRReplayError && err.code === 'replay';
          }
        },
      ),
      RUN_OPTS,
    );
  });
});

// ---------------------------------------------------------------------------
// P6.4 — Wrong studio: mismatched `studio` claim is rejected
// ---------------------------------------------------------------------------

describe('Property 6.4 — wrong studio (studio claim ≠ expected → invalid_token)', () => {
  it('rejects tokens whose studio claim differs from expectedStudioId', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Two UUID v4 strings; we skip samples where they
        // coincide so the property targets the mismatch branch.
        fc.uuid({ version: 4 }),
        fc.uuid({ version: 4 }),
        async (actualStudio, expectedStudio) => {
          fc.pre(actualStudio !== expectedStudio);

          const token = await generateAccessQR(USER_ID, actualStudio, {
            signingKey,
            now: () => FROZEN_NOW,
          });
          const replay = makeReplay();
          try {
            await verifyAccessQR(token, expectedStudio, {
              jwks,
              replayStore: replay,
              now: () => FROZEN_NOW + 1,
            });
            return false;
          } catch (err) {
            return err instanceof InvalidQRTokenError && err.code === 'invalid_token';
          }
        },
      ),
      RUN_OPTS,
    );
  });

  // Regression anchor: the asymmetric case above never exercises a
  // collision, but the happy path — expected === actual — must stay
  // green so a future refactor that over-rejects is caught early.
  it('accepts a token whose studio claim equals the expected studio', async () => {
    const token = await generateAccessQR(USER_ID, STUDIO_ID, {
      signingKey,
      now: () => FROZEN_NOW,
    });
    const replay = makeReplay();
    const result = await verifyAccessQR(token, STUDIO_ID, {
      jwks,
      replayStore: replay,
      now: () => FROZEN_NOW + 1,
    });
    expect(result.studioId).toBe(STUDIO_ID);
  });
});

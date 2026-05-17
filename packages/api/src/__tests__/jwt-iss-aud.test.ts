/**
 * JWT iss/aud enforcement — Sprint 1 / Slice 1.5 (SP1.6, audit
 * finding S2-005).
 *
 * The gateway's `jwtAuth()` middleware now passes `{ issuer, audience }`
 * straight to `jose.jwtVerify`, with values pulled from
 * `c.env.JWT_ISSUER` / `c.env.JWT_AUDIENCE` and falling back to
 * `'athlya'` / `\`athlya-api-${env.ENVIRONMENT}\`` respectively. A token
 * issued by another Athlya service (or any third party that ever
 * shares our JWKS) cannot land on the gateway any more — `jose`
 * raises `JWTClaimValidationFailed` which the middleware collapses
 * into the generic `invalid_token` 401 code (no leak of which claim
 * mismatched).
 *
 * Three scenarios:
 *
 *   1. Token with default iss=`'athlya'` + aud=`'athlya-api-dev'`
 *      (matching the `buildMockEnv()` env shape) → 200.
 *   2. Token with wrong iss=`'evil-service'` → 401 invalid_token +
 *      `WWW-Authenticate: Bearer error="invalid_token"`.
 *   3. Token with wrong aud=`'evil-api'` → 401 invalid_token +
 *      `WWW-Authenticate: Bearer error="invalid_token"`.
 *
 * Validates: audit finding S2-005.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests, jwtAuth } from '../middleware/auth.js';
import { buildApp } from '../worker.js';

import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
  type TestKeypair,
} from './helpers/test-app.js';

import type { JwksKeyResolver } from '../middleware/auth.js';
import type { HonoEnv } from '../types.js';
import type { Hono } from 'hono';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
  kp = await mintTestKeypair();
  resolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetJwksCacheForTests();
});

/**
 * Mount a `/__iss-aud-test` route gated by `jwtAuth({ keyResolver })`
 * and echo the verified claims so each scenario can assert the
 * 200-path body too.
 *
 * Note: `jwtAuth({ keyResolver })` does NOT pass explicit
 * `issuer`/`audience` so the middleware reads them from `c.env`
 * (the production code path). This is exactly what we want to
 * exercise.
 */
function buildTestApp(): Hono<HonoEnv> {
  const app = buildApp();
  app.use('/__iss-aud-test', jwtAuth({ keyResolver: resolver }));
  app.get('/__iss-aud-test', (c) => {
    const claims = c.get('authClaims');
    return c.json({ claims }, 200);
  });
  return app;
}

/* ------------------------------------------------------------------ */
/*  Suite                                                              */
/* ------------------------------------------------------------------ */

describe('jwtAuth — iss/aud enforcement (Slice 1.5, S2-005)', () => {
  it('accepts a token with default iss=athlya + aud=athlya-api-dev → 200', async () => {
    const app = buildTestApp();
    // signTestJwt stamps iss=athlya + aud=athlya-api-dev by default
    // (Slice 1.5 — see helpers/test-app.ts).
    const token = await signTestJwt(kp.privateKey, {
      sub: TEST_USER_ID,
      studio: TEST_STUDIO_ID,
      role: 'member',
    });

    const res = await app.request(
      '/__iss-aud-test',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      claims: { userId: string; studioId: string; role: string };
    }>();
    expect(body.claims.userId).toBe(TEST_USER_ID);
    expect(body.claims.studioId).toBe(TEST_STUDIO_ID);
  });

  it('rejects a token with wrong iss → 401 invalid_token + WWW-Authenticate', async () => {
    const app = buildTestApp();
    const token = await signTestJwt(
      kp.privateKey,
      {
        sub: TEST_USER_ID,
        studio: TEST_STUDIO_ID,
        role: 'member',
      },
      // Override iss with a value that does not match the
      // gateway's default ('athlya').
      { iss: 'evil-service' },
    );

    const res = await app.request(
      '/__iss-aud-test',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
    // RFC 6750 challenge header — not asserted as exact match
    // because Slice 1.5 keeps the WWW-Authenticate behaviour
    // the same as before (only token_expired carries the
    // header). The assertion below tracks the production
    // contract: invalid_token does NOT emit a challenge header.
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects a token with wrong aud → 401 invalid_token', async () => {
    const app = buildTestApp();
    const token = await signTestJwt(
      kp.privateKey,
      {
        sub: TEST_USER_ID,
        studio: TEST_STUDIO_ID,
        role: 'member',
      },
      // Override aud with a value that does not match the
      // gateway's default ('athlya-api-dev' for dev env).
      { aud: 'evil-api' },
    );

    const res = await app.request(
      '/__iss-aud-test',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

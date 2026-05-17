/**
 * Unit tests for the JWT authentication middleware (task 8.2).
 *
 * Scope:
 *   • Happy path — valid RS256 JWT signed with a test JWK → middleware
 *     calls `next()` and sets `authClaims` on the context.
 *   • Missing `Authorization` header → 401 `missing_authorization`,
 *     NO `WWW-Authenticate` header.
 *   • Malformed `Bearer garbage` → 401 `invalid_token`.
 *   • Expired token → 401 `token_expired` + `WWW-Authenticate: Bearer
 *     error="token_expired"` (Req 2.5).
 *   • Wrong `kid` → 401 `invalid_token`.
 *   • Wrong `alg` (HS256 instead of RS256) → 401 `invalid_token`.
 *   • Missing / out-of-range claims → 401 `invalid_token`.
 *
 * Strategy:
 *   - Build an isolated app via `buildApp()` so trace/logger context
 *     mirrors production wiring, then mount a `/__auth-test` route
 *     gated by `jwtAuth({ keyResolver })` that echoes the verified
 *     claims.
 *   - Mint tokens inline with `jose.SignJWT` + `generateKeyPair`
 *     keyed by a stable `kid` in the protected header.
 *   - Inject a synchronous `keyResolver` backed by
 *     `createLocalJWKSet` over the in-memory test keys, so the
 *     middleware never attempts a real network fetch. The production
 *     path (`createRemoteJWKSet`) is covered by `jose`'s own test
 *     suite and by task 8.12's integration tests.
 *
 * Validates: Requirements 2.5, 14.1.
 */

import { SignJWT, createLocalJWKSet, errors as joseErrors, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests, jwtAuth, type JwksKeyResolver } from '../middleware/auth.js';
import { buildApp } from '../worker.js';

import type { AthlyaBindings } from '../types.js';
import type { JWK, KeyLike } from 'jose';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Stable kid used by the happy-path signing key. */
const TEST_KID = 'test-kid';

/** UUID-shaped claim values — match the auth service's conventions. */
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_STUDIO_ID = '22222222-2222-4222-8222-222222222222';

/** Minimal env object — the middleware only reads `JWT_JWKS_URL`
 * when no `keyResolver` is injected. The test uses an injected
 * resolver so the URL value is irrelevant here. */
function mockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_DLQ: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: '',
    REDIS_URL: '',
    REDIS_TOKEN: '',
    JWT_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
    VERSION: 'test',
    ...overrides,
  };
}

/** RSA 2048-bit keypair reused across all tests in this suite.
 * Minted once in `beforeAll` to amortise the ~100 ms generation cost. */
interface Keypair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
}

async function mintRs256Keypair(): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicKey, publicJwk };
}

/**
 * HS256 secret used by the "wrong alg" test. The value is irrelevant
 * to the assertion — the middleware rejects on the `alg` header
 * mismatch before it ever touches the key material.
 */
function hs256Secret(): Uint8Array {
  return new TextEncoder().encode('test-hs256-secret-at-least-32-bytes-long!!!');
}

/**
 * Build a synchronous `JwksKeyResolver` backed by `createLocalJWKSet`
 * so the middleware has zero dependency on network I/O during tests.
 * The resolver accepts only the `publicJwk` under `kid = TEST_KID`;
 * any token whose header carries a different `kid` triggers the
 * "no matching key" branch in `jose`.
 */
function buildLocalResolver(publicJwk: JWK, kid: string): JwksKeyResolver {
  const jwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: 'RS256',
        use: 'sig',
      } satisfies JWK,
    ],
  };
  return createLocalJWKSet(jwks);
}

/**
 * Mint an access-shaped JWT for the supplied claims. `kid` is the
 * `kid` written into the protected header — defaults to the
 * happy-path value so most call sites can omit it.
 *
 * Slice 1.5 (SP1.6, audit S2-005): stamps `iss = 'athlya'` and
 * `aud = 'athlya-api-dev'` by default to satisfy the gateway's
 * issuer/audience enforcement under the test `mockEnv()`
 * fixture (which sets `ENVIRONMENT = 'dev'` with no overrides
 * for `JWT_ISSUER` / `JWT_AUDIENCE`, so the gateway falls back
 * to those exact defaults).
 */
async function signTestToken(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  opts: {
    kid?: string;
    expSec?: number;
    iatSec?: number;
    iss?: string | null;
    aud?: string | null;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const builder = new SignJWT(claims)
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
      kid: opts.kid ?? TEST_KID,
    })
    .setIssuedAt(opts.iatSec ?? now)
    .setExpirationTime(opts.expSec ?? now + 60);
  const iss = opts.iss === undefined ? 'athlya' : opts.iss;
  if (iss !== null) builder.setIssuer(iss);
  const aud = opts.aud === undefined ? 'athlya-api-dev' : opts.aud;
  if (aud !== null) builder.setAudience(aud);
  return builder.sign(privateKey);
}

/**
 * Boot a fresh `buildApp()` wired with `jwtAuth({ keyResolver })` on
 * `/__auth-test`. The handler echoes `c.get('authClaims')` so the
 * happy-path test can assert the middleware's context injection
 * directly.
 */
function buildTestApp(resolver: JwksKeyResolver): ReturnType<typeof buildApp> {
  const app = buildApp();
  app.use('/__auth-test', jwtAuth({ keyResolver: resolver }));
  app.get('/__auth-test', (c) => {
    const claims = c.get('authClaims');
    return c.json({ claims }, 200);
  });
  return app;
}

/* ------------------------------------------------------------------ */
/*  Suite                                                              */
/* ------------------------------------------------------------------ */

describe('jwtAuth middleware', () => {
  let kp: Keypair;
  let resolver: JwksKeyResolver;

  beforeEach(async () => {
    // Silence the structured logger lines emitted by the trace
    // middleware so the test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    // Fresh JWKS cache so any accidentally-left-over remote
    // getter from a prior test cannot interfere.
    __resetJwksCacheForTests();

    kp = await mintRs256Keypair();
    resolver = buildLocalResolver(kp.publicJwk, TEST_KID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetJwksCacheForTests();
  });

  /* -------------------------------------------------------------- */
  /*  Happy path                                                    */
  /* -------------------------------------------------------------- */

  it('accepts a valid RS256 JWT and injects authClaims into the context', async () => {
    const app = buildTestApp(resolver);
    const token = await signTestToken(kp.privateKey, {
      sub: TEST_USER_ID,
      studio: TEST_STUDIO_ID,
      role: 'member',
    });

    const res = await app.request(
      '/__auth-test',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json<{
      claims: {
        userId: string;
        studioId: string;
        role: 'member' | 'admin' | 'coach';
      };
    }>();
    expect(body.claims).toEqual({
      userId: TEST_USER_ID,
      studioId: TEST_STUDIO_ID,
      role: 'member',
    });
  });

  it('accepts admin and coach roles too', async () => {
    const app = buildTestApp(resolver);
    for (const role of ['admin', 'coach'] as const) {
      const token = await signTestToken(kp.privateKey, {
        sub: TEST_USER_ID,
        studio: TEST_STUDIO_ID,
        role,
      });
      const res = await app.request(
        '/__auth-test',
        {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
        },
        mockEnv(),
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ claims: { role: string } }>();
      expect(body.claims.role).toBe(role);
    }
  });

  /* -------------------------------------------------------------- */
  /*  Missing authorization                                         */
  /* -------------------------------------------------------------- */

  it('rejects a request with no Authorization header (401 missing_authorization, no WWW-Authenticate)', async () => {
    const app = buildTestApp(resolver);

    const res = await app.request('/__auth-test', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('www-authenticate')).toBeNull();

    const body = await res.json<{
      type: string;
      title: string;
      status: number;
      traceId: string;
    }>();
    expect(body.title).toBe('missing_authorization');
    expect(body.type).toBe('about:blank');
    expect(body.status).toBe(401);
    expect(typeof body.traceId).toBe('string');
    expect(body.traceId.length).toBeGreaterThan(0);
  });

  /* -------------------------------------------------------------- */
  /*  Malformed token                                               */
  /* -------------------------------------------------------------- */

  it('rejects "Bearer garbage" with 401 invalid_token', async () => {
    const app = buildTestApp(resolver);

    const res = await app.request(
      '/__auth-test',
      { method: 'GET', headers: { authorization: 'Bearer garbage' } },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
    // No WWW-Authenticate on invalid_token either — only
    // token_expired carries the RFC 6750 challenge (Req 2.5).
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects a non-Bearer scheme with 401 invalid_token', async () => {
    const app = buildTestApp(resolver);

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
  });

  /* -------------------------------------------------------------- */
  /*  Expired token                                                 */
  /* -------------------------------------------------------------- */

  it('rejects an expired token with 401 token_expired + WWW-Authenticate challenge (Req 2.5)', async () => {
    const app = buildTestApp(resolver);
    const now = Math.floor(Date.now() / 1_000);
    const token = await signTestToken(
      kp.privateKey,
      {
        sub: TEST_USER_ID,
        studio: TEST_STUDIO_ID,
        role: 'member',
      },
      {
        iatSec: now - 120,
        expSec: now - 60, // expired 60 s ago
      },
    );

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('www-authenticate')).toBe('Bearer error="token_expired"');
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('token_expired');
  });

  /* -------------------------------------------------------------- */
  /*  Wrong kid                                                     */
  /* -------------------------------------------------------------- */

  it('rejects a token whose kid does not match any JWKS entry (401 invalid_token)', async () => {
    const app = buildTestApp(resolver);
    const token = await signTestToken(
      kp.privateKey,
      {
        sub: TEST_USER_ID,
        studio: TEST_STUDIO_ID,
        role: 'member',
      },
      { kid: 'unknown-kid' },
    );

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  /* -------------------------------------------------------------- */
  /*  Wrong alg                                                     */
  /* -------------------------------------------------------------- */

  it('rejects a token signed with HS256 instead of RS256 (401 invalid_token)', async () => {
    const app = buildTestApp(resolver);
    // Sign with HS256 directly — the middleware pins `algorithms:
    // ['RS256']`, so `jose` throws `JOSEAlgNotAllowed` before
    // attempting any JWKS lookup.
    const token = await new SignJWT({
      sub: TEST_USER_ID,
      studio: TEST_STUDIO_ID,
      role: 'member',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: TEST_KID })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(hs256Secret());

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
  });

  /* -------------------------------------------------------------- */
  /*  Missing / invalid claims                                      */
  /* -------------------------------------------------------------- */

  it('rejects a token missing the studio claim (401 invalid_token)', async () => {
    const app = buildTestApp(resolver);
    const token = await signTestToken(kp.privateKey, {
      sub: TEST_USER_ID,
      // no `studio`
      role: 'member',
    });

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
  });

  it('rejects a token whose role is outside the closed set (401 invalid_token)', async () => {
    const app = buildTestApp(resolver);
    const token = await signTestToken(kp.privateKey, {
      sub: TEST_USER_ID,
      studio: TEST_STUDIO_ID,
      role: 'owner', // not in {'member','admin','coach'}
    });

    const res = await app.request(
      '/__auth-test',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      },
      mockEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ title: string }>();
    expect(body.title).toBe('invalid_token');
  });

  /* -------------------------------------------------------------- */
  /*  Sanity: JOSE error classes surface where expected             */
  /* -------------------------------------------------------------- */

  it('jose.errors.JWTExpired is the class the middleware branches on', () => {
    // Guard against an accidental `jose` upgrade that renames the
    // error class. If this test fails, the middleware's
    // token_expired branch needs to be updated to match.
    expect(typeof joseErrors.JWTExpired).toBe('function');
  });
});

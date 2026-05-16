/**
 * Test infrastructure for the H4 middleware-chain integration suite.
 *
 * Hardening plan H4 (see `.kiro/specs/athlya-platform/hardening-plan.md`)
 * replaces the Miniflare-based task 8.12 attempt with an in-process
 * variant built on Hono's `app.request(path, init, env)` API. That
 * call runs the full `buildApp()` middleware chain synchronously in
 * the test process against a mocked `env` binding object — no Docker,
 * no Wrangler, no cold-starts.
 *
 * This helper module owns the three pieces every H4 scenario re-uses:
 *
 *   1. {@link buildTestApp} — composes a fresh `buildApp()` with a
 *      small test router (`/v1/test/public`, `/v1/test/authed`,
 *      `/v1/test/echo`, `/v1/test/tenant`, `/v1/test/boom`) mounted
 *      in the production-intended middleware order
 *      (auth → rate-limit → route). The order is load-bearing: it
 *      proves that e.g. rate-limit runs AFTER auth so 429 responses
 *      to authenticated clients use the user-bucket semantics
 *      instead of the IP bucket.
 *
 *   2. {@link buildMockEnv} — returns an {@link AthlyaBindings} with
 *      the minimal safe defaults. No field points at a real
 *      dependency (the DB URL is an `.invalid` domain, Redis / JWKS
 *      likewise); tests that need a specific behaviour inject via
 *      `overrides`.
 *
 *   3. {@link signTestJwt} / {@link mintTestKeypair} /
 *      {@link buildLocalResolver} — mirror the pattern
 *      `src/__tests__/auth.test.ts` uses. A single RS256 keypair is
 *      minted per-suite and fed into `createLocalJWKSet`, which is
 *      wired into the middleware as the `keyResolver` override. No
 *      network I/O ever reaches `createRemoteJWKSet`.
 *
 * The fake Upstash client lives in `tests/helpers/fake-redis.ts`
 * (task 4.1) and is re-exported from this module so a single import
 * gives every H4 test everything it needs.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';
import { z } from 'zod';

import { jwtAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { notFoundOnEmpty, withTenantTx } from '../../middleware/tenant.js';
import { zValidator } from '../../middleware/validator.js';
import { __buildAppInternal, buildApp } from '../../worker.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';
import type { AthlyaBindings, HonoEnv } from '../../types.js';
import type { Redis } from '@upstash/redis';
import type { Hono } from 'hono';
import type { JWK, KeyLike } from 'jose';

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export { FakeRedis } from '../../../tests/helpers/fake-redis.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** `kid` header value carried by every JWT this helper mints. */
export const TEST_KID = 'h4-test-kid';

/** UUID v4 used as the default `sub` / userId across H4 tests. */
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

/** UUID v4 used as the default `studio` / studioId across H4 tests. */
export const TEST_STUDIO_ID = '22222222-2222-4222-8222-222222222222';

/* ------------------------------------------------------------------ */
/*  Keypair + JWKS                                                     */
/* ------------------------------------------------------------------ */

/** RS256 keypair + extracted public JWK, ready to feed the resolver. */
export interface TestKeypair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  publicJwk: JWK;
}

/**
 * Mint a fresh RS256 keypair. Call once per suite in `beforeAll` and
 * reuse — the ~100 ms generation cost is enough that doing it per
 * test balloons the suite runtime.
 */
export async function mintTestKeypair(): Promise<TestKeypair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicKey, publicJwk };
}

/**
 * Build a synchronous {@link JwksKeyResolver} backed by
 * {@link createLocalJWKSet} so the middleware performs zero network
 * I/O. Any token whose `kid` header does not match is rejected by
 * `jose`'s own JWKS lookup with `JWKSNoMatchingKey`, which the auth
 * middleware collapses to a 401 `invalid_token`.
 */
export function buildLocalResolver(publicJwk: JWK, kid: string = TEST_KID): JwksKeyResolver {
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
 * Options accepted by {@link signTestJwt}. Defaults match the
 * production Auth service's conventions: RS256, 60-second lifetime
 * from "now", default kid.
 *
 * Slice 1.5 — Sprint 1 — SP1.6 (audit finding S2-005): the gateway
 * now enforces `iss` and `aud` claims via `jose.jwtVerify`. The
 * helper stamps them by default so existing tests stay green:
 *
 *   - `iss` defaults to `'athlya'` (matches the gateway's
 *     `JWT_ISSUER` fallback when the binding is absent — which is
 *     the case for the `buildMockEnv()` fixture used by every test
 *     file in this package).
 *   - `aud` defaults to `'athlya-api-dev'` (matches the gateway's
 *     `JWT_AUDIENCE` fallback `\`athlya-api-${env.ENVIRONMENT}\``
 *     when `env.ENVIRONMENT === 'dev'`, which {@link buildMockEnv}
 *     sets by default).
 *
 * Tests that need to override either claim (negative-case suites
 * exercising bad iss / bad aud) pass `iss` / `aud` explicitly.
 */
export interface SignTestJwtOptions {
  /** `kid` header value. Defaults to {@link TEST_KID}. */
  kid?: string;
  /** `exp` claim in seconds since epoch. Defaults to now + 60 s. */
  expSec?: number;
  /** `iat` claim in seconds since epoch. Defaults to now. */
  iatSec?: number;
  /**
   * `iss` claim. Defaults to `'athlya'` — match the gateway's
   * default in `buildMockEnv()`-backed tests. Pass `null` to
   * skip stamping the claim entirely (negative tests).
   */
  iss?: string | null;
  /**
   * `aud` claim. Defaults to `'athlya-api-dev'`. Pass `null` to
   * skip stamping the claim entirely.
   */
  aud?: string | null;
}

/** Default `iss` claim posted by every JWT this helper mints. */
export const TEST_JWT_ISSUER = 'athlya';

/** Default `aud` claim — matches `athlya-api-${ENVIRONMENT}` for `dev`. */
export const TEST_JWT_AUDIENCE = 'athlya-api-dev';

/**
 * Sign a JWT with the supplied private key and claims. Mirrors the
 * lightweight `signTestToken` helper in `auth.test.ts` so the two
 * test suites stay in lock-step.
 *
 * Payload claims are accepted as an arbitrary record so each test
 * can exercise shape variations (missing `studio`, out-of-range
 * `role`, …) without a fresh helper per case.
 */
export async function signTestJwt(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  opts: SignTestJwtOptions = {},
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

  // Stamp iss/aud unless the caller explicitly passed `null` to
  // skip them (used by negative tests that probe the gateway's
  // claim enforcement). Slice 1.5 — Sprint 1 — SP1.6.
  const iss = opts.iss === undefined ? TEST_JWT_ISSUER : opts.iss;
  if (iss !== null) builder.setIssuer(iss);
  const aud = opts.aud === undefined ? TEST_JWT_AUDIENCE : opts.aud;
  if (aud !== null) builder.setAudience(aud);

  return builder.sign(privateKey);
}

/* ------------------------------------------------------------------ */
/*  Mock env                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build an {@link AthlyaBindings} with safe defaults.
 *
 *   • DB_URL / REDIS_URL / JWT_JWKS_URL point at `.invalid`
 *     hostnames per RFC 6761 §6.4 so an accidental real fetch /
 *     connection attempt fails fast and loudly rather than hanging
 *     the suite.
 *   • EVENTS_QUEUE.send is a `vi.fn()` that resolves to `undefined`
 *     — the chain tests never publish events but the shape must be
 *     present because `AthlyaBindings` declares it as required.
 *   • OTEL_EXPORTER_OTLP_ENDPOINT is intentionally `undefined`;
 *     tests that exercise the exporter override it via the
 *     `overrides` parameter AND stub `globalThis.fetch`.
 */
export function buildMockEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  const base: AthlyaBindings = {
    ENVIRONMENT: 'dev',
    EVENTS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_QUEUE'],
    EVENTS_DLQ: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_DLQ'],
    DB_URL: 'postgres://test.invalid/athlya',
    REDIS_URL: 'https://test.upstash.invalid',
    REDIS_TOKEN: 'h4-test-token',
    JWT_JWKS_URL: 'https://auth.test.invalid/.well-known/jwks.json',
    VERSION: 'h4-test',
  };
  return { ...base, ...overrides };
}

/* ------------------------------------------------------------------ */
/*  Domain-routes-suppressed app factory                               */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by {@link buildAppNoDomainRoutes}.
 */
export interface BuildAppNoDomainRoutesOptions {
  /** Optional domain deps bundle. When unset, the factory uses the
   *  same lazy-stub path as production. */
  readonly deps?: DomainDeps;
}

/**
 * Build a {@link buildApp}-equivalent Hono instance whose `/v1/*`
 * domain routers are NOT mounted.
 *
 * Sprint 11 / Slice 11.1 (critique C2.2). The middleware-chain tests
 * (`security-hardening-1-2.test.ts`, `middleware-chain.test.ts`) and
 * the rate-limit composition factory in `integration-helpers.ts`
 * need the full pipeline (host check, security headers, OTel,
 * tracing, etc.) but compose their own `/v1/*` routes on top — so
 * the production domain mount must be suppressed. Historically this
 * was a `skipDomainRoutes` flag on the public `BuildAppOptions`,
 * which carried the risk of being passed from real application code.
 * The flag is now scoped to {@link __buildAppInternal} (private to
 * `worker.ts`) and re-exposed only through this test helper.
 */
export function buildAppNoDomainRoutes(options: BuildAppNoDomainRoutesOptions = {}): Hono<HonoEnv> {
  return __buildAppInternal({
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
    skipDomainRoutes: true,
  });
}

/* ------------------------------------------------------------------ */
/*  Test app factory                                                   */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by {@link buildTestApp}.
 *
 *   • `jwksResolver` — the only required field. Every H4 scenario
 *     builds a resolver via {@link buildLocalResolver} so the
 *     middleware never touches the network.
 *   • `rateLimit` — optional. When present, mounts the
 *     {@link rateLimit} middleware on `/v1/test/*` with the supplied
 *     Redis client and limits. When absent, the rate-limit tests
 *     are skipped by construction so the other scenarios do not pay
 *     a pipeline allocation per request.
 */
export interface BuildTestAppOptions {
  readonly jwksResolver: JwksKeyResolver;
  readonly rateLimit?: {
    readonly redis: Redis;
    readonly ipLimit?: number;
    readonly userLimit?: number;
    readonly windowSec?: number;
  };
}

/**
 * Build a fresh test app mounted on top of the unchanged
 * {@link buildApp} factory.
 *
 * Middleware mount order mirrors what task 8.11 will eventually wire
 * in production:
 *
 *   1. Security headers + tracing/logger + OTel span + serve-log —
 *      supplied by `buildApp()` at construction time.
 *   2. {@link jwtAuth} on the two authenticated paths. Registered
 *      BEFORE rate-limit so `authClaims` is set by the time the
 *      limiter decides between the IP and user buckets — otherwise
 *      an authenticated client's 429s would be attributed to their
 *      IP, which the hardening plan flags as the canonical ordering
 *      bug this suite must guard.
 *   3. {@link rateLimit} on `/v1/test/*`. Mounted after auth so the
 *      user bucket wins for authenticated requests.
 *   4. Route handlers — one per H4 scenario.
 *
 * The route handlers stay intentionally minimal: each exists only so
 * the chain test has something to exercise. Domain logic is owned by
 * dedicated packages; we care about the glue here.
 */
export function buildTestApp(options: BuildTestAppOptions): Hono<HonoEnv> {
  const app = buildApp();

  // Auth-gated paths are registered FIRST so `jwtAuth` runs before
  // any rate-limit registration below. Order is load-bearing — see
  // the factory doc for why.
  const auth = jwtAuth({ keyResolver: options.jwksResolver });
  app.use('/v1/test/authed', auth);
  app.use('/v1/test/tenant', auth);

  // Rate-limit spans every /v1/test/* path but mounts AFTER auth so
  // `authClaims.userId` is readable on authenticated routes.
  if (options.rateLimit !== undefined) {
    const { redis, ipLimit, userLimit, windowSec } = options.rateLimit;
    app.use(
      '/v1/test/*',
      rateLimit({
        redis,
        ...(ipLimit !== undefined ? { ipLimit } : {}),
        ...(userLimit !== undefined ? { userLimit } : {}),
        ...(windowSec !== undefined ? { windowSec } : {}),
      }),
    );
  }

  /* -------------------------------------------------------------- */
  /*  Test routes                                                    */
  /* -------------------------------------------------------------- */

  /** Public, no-auth route. Used by the happy-path + IP rate-limit tests. */
  app.get('/v1/test/public', (c) => {
    return c.json({ ok: true });
  });

  /**
   * Auth-gated route. Returns the verified claims so the test can
   * assert `jwtAuth` injected them into the context.
   */
  app.get('/v1/test/authed', (c) => {
    const claims = c.get('authClaims');
    return c.json({ claims: claims ?? null });
  });

  /**
   * Validated POST. The schema is the smallest shape the task
   * cares about: `{ name: string, min(1) }`. Missing / empty
   * `name` surfaces a Zod issue which the validator throws as a
   * {@link import('../../middleware/validator.js').ValidationError}
   * and the global onError renders as 422 Problem Details.
   */
  app.post('/v1/test/echo', zValidator('json', z.object({ name: z.string().min(1) })), (c) => {
    // `validated:json` is written onto the context by the
    // validator middleware above. The Hono-level key is a
    // free-form string (see `validator.ts`), so it is not
    // part of the {@link import('../../types.js').AthlyaVariables}
    // surface and needs a narrow cast here.
    const body = (c.get('validated:json' as never) ?? {}) as { name: string };
    return c.json(body);
  });

  /**
   * Tenant-scoped GET. Runs a fabricated single-row lookup that
   * always comes back empty; {@link notFoundOnEmpty} turns the
   * empty array into a {@link import('../../middleware/tenant.js').TenantResourceNotFoundError}
   * which the global onError renders as 404 Problem Details. This
   * path never issues SQL — `@athlya/db` is mocked at the test
   * suite level so no real Postgres connection is opened.
   */
  app.get('/v1/test/tenant', async (c) => {
    const rows = await withTenantTx(c, async () => [] as unknown[]);
    const row = notFoundOnEmpty(rows);
    return c.json(row as Record<string, unknown>);
  });

  /**
   * Throwing route. The thrown error carries a deliberate secret
   * substring so the 500-fallback test can assert the Problem
   * Details body never leaks it.
   */
  app.get('/v1/test/boom', () => {
    throw new Error('db password is hunter2');
  });

  return app;
}

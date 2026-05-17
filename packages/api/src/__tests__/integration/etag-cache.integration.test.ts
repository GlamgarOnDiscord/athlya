/**
 * ETag + Cache-Control integration tests â€” slice B5 (perf).
 *
 * What this suite covers
 * ----------------------
 * The performance hardening slice B5 adds transport-level caching
 * to the two read-heavy listing endpoints:
 *
 *   â€¢ `GET /v1/classes`  â€” `Cache-Control: private, max-age=10` +
 *     strong ETag derived from the listing fingerprint.
 *   â€¢ `GET /v1/reservations/me` â€” `Cache-Control: private, max-age=5`
 *     (shorter window because reservation status mutates in real
 *     time on cancellation / waitlist promotion).
 *
 * Both endpoints honour `If-None-Match`: a request whose
 * `If-None-Match` value matches the freshly-computed ETag receives
 * an empty `304 Not Modified` carrying the same `etag`,
 * `cache-control` and `vary` headers. Mismatches produce the full
 * `200 OK` payload and surface the new ETag.
 *
 * Test surface
 * ------------
 *   1. `GET /v1/classes` happy path â†’ 200 + `etag` + `cache-control`
 *      + `vary` set.
 *   2. `If-None-Match` matching the freshly-computed ETag â†’ 304 with
 *      empty body and the same headers.
 *   3. `If-None-Match` not matching â†’ 200 with a fresh ETag.
 *   4. The same three assertions for `GET /v1/reservations/me`,
 *      whose Cache-Control window is 5 s rather than 10 s.
 *
 * Why an integration suite?
 * ------------------------
 * The route-level unit tests (under `packages/api/src/__tests__/routes/`)
 * exercise the unauthenticated chain only â€” they cannot reach the
 * handler that emits the ETag. The gateway integration suite already
 * wires the JWKS / DB mocks needed to land an authenticated request
 * on the real handler, so we re-use the same `buildIntegrationApp`
 * + `signUserJwt` infrastructure here without copying the auth
 * machinery into a third place.
 *
 * Validates: B5.1, B5.2.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { __resetRateLimitRedisCache } from '../../middleware/rate-limit.js';
import { __resetTenantDbCache } from '../../middleware/tenant.js';

import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildIntegrationApp,
  buildIntegrationDeps,
  buildLocalResolver,
  buildMockEnv,
  createIntegrationState,
  makeUuid,
  mintTestKeypair,
  signUserJwt,
  type IntegrationState,
  type TestKeypair,
  type UserRecord,
} from './integration-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';

/* ------------------------------------------------------------------ */
/*  @athlya/db mock                                                    */
/* ------------------------------------------------------------------ */

const dbMocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  withTenant: vi.fn(),
  lookup: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@athlya/db', () => ({
  createDb: dbMocks.createDb,
  withTenant: dbMocks.withTenant,
}));

vi.mock('@athlya/db/idempotency', () => ({
  lookup: dbMocks.lookup,
  store: dbMocks.store,
  DEFAULT_IDEMPOTENCY_TTL_SEC: 86_400,
}));

/* ------------------------------------------------------------------ */
/*  jose mock â€” local resolver only                                    */
/* ------------------------------------------------------------------ */

const joseHoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (joseHoisted.localResolver === null) {
          throw new Error('etag-cache integration: local resolver missing');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
  kp = await mintTestKeypair();
  resolver = buildLocalResolver(kp.publicJwk);
  joseHoisted.localResolver = resolver;
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  __resetJwksCacheForTests();
  __resetRateLimitRedisCache();
  __resetTenantDbCache();

  dbMocks.createDb.mockReset();
  dbMocks.withTenant.mockReset();
  dbMocks.lookup.mockReset();
  dbMocks.store.mockReset();
  dbMocks.createDb.mockReturnValue({ __brand: 'fake-db' });
  dbMocks.withTenant.mockImplementation(
    async (_db: unknown, _claims: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ __brand: 'fake-tx' }),
  );
  dbMocks.lookup.mockResolvedValue(null);
  dbMocks.store.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Compose an integration app pre-seeded with one user (Alice) and a
 * single class so both GETs return a non-empty payload. Returns the
 * fresh JWT plus the wired `app`.
 */
async function makeApp(): Promise<{
  readonly app: ReturnType<typeof buildIntegrationApp>;
  readonly token: string;
  readonly state: IntegrationState;
}> {
  const state = createIntegrationState();
  const aliceId = TEST_USER_ID;
  const aliceUser: UserRecord = {
    userId: aliceId,
    email: 'alice@example.com',
    studioId: TEST_STUDIO_ID,
    displayName: 'Alice',
    role: 'member',
  };
  state.users.set(aliceId, aliceUser);
  state.usersByEmail.set('alice@example.com', aliceUser);

  // Seed one class so /v1/classes returns at least one item.
  const classId = makeUuid(101);
  state.classes.set(classId, {
    id: classId,
    title: 'Yoga',
    studioId: TEST_STUDIO_ID,
    capacity: 10,
    startsAt: '2099-04-01T09:00:00.000Z',
  });

  // Seed one reservation so /v1/reservations/me returns at least
  // one item.
  const resId = makeUuid(2001);
  state.reservationsById.set(resId, {
    id: resId,
    classId,
    userId: aliceId,
    status: 'confirmed',
  });
  state.reservationsByClass.set(classId, [state.reservationsById.get(resId)!]);

  const deps: DomainDeps = buildIntegrationDeps({
    state,
    signSessionToken: async (u: UserRecord) =>
      signUserJwt(kp, {
        userId: u.userId,
        studioId: u.studioId,
        role: u.role,
      }),
  });

  const app = buildIntegrationApp({ deps, jwksResolver: resolver });
  const token = await signUserJwt(kp, {
    userId: aliceId,
    studioId: TEST_STUDIO_ID,
    role: 'member',
  });

  return { app, token, state };
}

/* ------------------------------------------------------------------ */
/*  GET /v1/classes â€” B5.1                                             */
/* ------------------------------------------------------------------ */

describe('GET /v1/classes â€” ETag + Cache-Control (B5.1)', () => {
  it('emits etag, cache-control private max-age=10, and vary headers on 200', async () => {
    const { app, token } = await makeApp();

    const res = await app.request(
      '/v1/classes?from=2099-04-01T00:00:00.000Z&to=2099-06-30T00:00:00.000Z',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=10, must-revalidate');
    expect(res.headers.get('vary')?.toLowerCase()).toContain('authorization');

    const etag = res.headers.get('etag');
    expect(etag).not.toBeNull();
    // Strong, quoted, 16 hex chars (64-bit truncation of SHA-256).
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    const body = (await res.json()) as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items as unknown[]).length).toBeGreaterThan(0);
  });

  it('If-None-Match matching the fresh ETag â†’ 304 with empty body and same cache headers', async () => {
    const { app, token } = await makeApp();

    const first = await app.request(
      '/v1/classes?from=2099-04-01T00:00:00.000Z&to=2099-06-30T00:00:00.000Z',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();

    const second = await app.request(
      '/v1/classes?from=2099-04-01T00:00:00.000Z&to=2099-06-30T00:00:00.000Z',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'if-none-match': etag!,
        },
      },
      buildMockEnv(),
    );

    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('private, max-age=10, must-revalidate');
    // 304 carries an empty body per RFC 7232.
    const text = await second.text();
    expect(text).toBe('');
  });

  it('If-None-Match mismatch â†’ 200 with the fresh ETag', async () => {
    const { app, token } = await makeApp();

    const res = await app.request(
      '/v1/classes?from=2099-04-01T00:00:00.000Z&to=2099-06-30T00:00:00.000Z',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          // Random non-matching value.
          'if-none-match': '"deadbeefdeadbeef"',
        },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const etag = res.headers.get('etag');
    expect(etag).not.toBe('"deadbeefdeadbeef"');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /v1/reservations/me â€” B5.2                                     */
/* ------------------------------------------------------------------ */

describe('GET /v1/reservations/me â€” ETag + Cache-Control (B5.2)', () => {
  it('emits etag, cache-control private max-age=5, and vary headers on 200', async () => {
    const { app, token } = await makeApp();

    const res = await app.request(
      '/v1/reservations/me',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=5, must-revalidate');
    expect(res.headers.get('vary')?.toLowerCase()).toContain('authorization');

    const etag = res.headers.get('etag');
    expect(etag).not.toBeNull();
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('If-None-Match matching the fresh ETag â†’ 304 with empty body', async () => {
    const { app, token } = await makeApp();

    const first = await app.request(
      '/v1/reservations/me',
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      buildMockEnv(),
    );
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();

    const second = await app.request(
      '/v1/reservations/me',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'if-none-match': etag!,
        },
      },
      buildMockEnv(),
    );

    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('private, max-age=5, must-revalidate');
    const text = await second.text();
    expect(text).toBe('');
  });
});

/**
 * Multi-tenant isolation integration tests â€” task 15.3.
 *
 * Two studios are seeded (`STUDIO_A`, `STUDIO_B`). Users of one
 * studio are systematically denied visibility of the other studio's
 * resources: every cross-tenant access surfaces HTTP 404 with a
 * Problem Details envelope whose `code` is `not_found`. The one
 * legitimate 403 in this suite is the role guard on
 * `GET /v1/members` (admin/coach only) â€” a role failure, NOT a
 * cross-tenant leak.
 *
 * Why 404 instead of 403?
 * -----------------------
 * Requirement 13.5 is explicit: resource existence MUST NOT be
 * disclosed across tenants. A 403 would tell an attacker that the
 * target id exists in another studio, which is a leak. The
 * post-RLS simulation (see `cancelReservation` / `updateClass` stub
 * overrides below) mirrors the production behaviour where a row
 * from another studio is simply not visible to the current
 * `SET LOCAL` transaction, so the service returns `not_found`
 * rather than an authorization failure.
 *
 * Scope
 * -----
 * Task 8.12's `gateway.integration.test.ts` already covers ONE
 * cross-tenant case (`PATCH /v1/classes/:id` returning `not_found`)
 * plus the Turnstile, rate-limit and happy-path flows on a single
 * tenant. This suite extends the tenant-isolation coverage to
 * EVERY user-facing tenant-scoped endpoint:
 *
 *   â€¢ `GET /v1/classes` â€” listing scoped to the caller's studio.
 *   â€¢ `GET /v1/reservations/me` â€” scoped to the caller's userId.
 *   â€¢ `DELETE /v1/reservations/:id` â€” cross-user cancels.
 *   â€¢ `PATCH /v1/classes/:id` â€” cross-tenant admin mutation.
 *   â€¢ `GET /v1/members/me` â€” profile scoped to the caller.
 *   â€¢ `GET /v1/members/` â€” role guard (legitimate 403).
 *
 * The `buildIntegrationDeps` stubs already filter by `studioId`
 * (`classes.listClasses`) and `userId`
 * (`reservations.listMyReservations` / `cancelReservation`), so no
 * production code changes are needed; the test file is pure
 * infrastructure + assertions.
 *
 * Validates: Requirements 13.2, 13.3, 13.5.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { __resetRateLimitRedisCache } from '../../middleware/rate-limit.js';
import { __resetTenantDbCache } from '../../middleware/tenant.js';

import {
  ADMIN_A_ID,
  ALICE_ID,
  BOB_ID,
  CLASS_A_ID,
  CLASS_B_ID,
  RESERVATION_A_ID,
  RESERVATION_B_ID,
  STUDIO_A_ID,
  STUDIO_B_ID,
  buildIntegrationApp,
  buildIntegrationDeps,
  buildLocalResolver,
  buildMockEnv,
  createIntegrationState,
  mintTestKeypair,
  seedTwoStudios,
  signUserJwt,
  type IntegrationState,
  type TestKeypair,
  type UserRecord,
} from './integration-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';

/* ------------------------------------------------------------------ */
/*  @athlya/db mock â€” no real Postgres in integration tests.          */
/* ------------------------------------------------------------------ */

// Copied verbatim from `gateway.integration.test.ts`. Sharing these
// mocks through a common module would couple the two suites' hoisted
// state together (vitest re-evaluates `vi.hoisted` per file, but the
// mocked module identity is process-wide), and independent state is
// load-bearing for the assertions that `dbMocks.*` are only called
// inside their own suite.
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
/*  jose mock â€” redirect createRemoteJWKSet to a local resolver.      */
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
          throw new Error('integration-test jose mock: local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

/* ------------------------------------------------------------------ */
/*  Types / helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Assert that a cross-tenant (or cross-user) access returned the
 * canonical 404 + `not_found` Problem Details envelope mandated by
 * Req 13.5.
 *
 * The 403 assertion is deliberately a negative one â€” 403 would leak
 * the fact that the target resource exists in a sibling tenant,
 * which is the whole point of the isolation guarantee.
 */
async function expectCrossTenantNotFound(response: Response): Promise<void> {
  // Req 13.5: never 403, never 401 â€” the resource must appear to
  // simply not exist from the other tenant's point of view.
  expect(response.status).toBe(404);
  expect(response.status).not.toBe(403);
  expect(response.status).not.toBe(401);
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  const body = (await response.json()) as any;
  expect(body.status).toBe(404);
  expect(body.code).toBe('not_found');
  expect(body.traceId).toBe(response.headers.get('x-trace-id'));
}

/* ------------------------------------------------------------------ */
/*  Suite-scoped fixtures                                              */
/* ------------------------------------------------------------------ */

let kp: TestKeypair;
let resolver: JwksKeyResolver;

beforeAll(async () => {
  kp = await mintTestKeypair();
  resolver = buildLocalResolver(kp.publicJwk);
  joseHoisted.localResolver = resolver;
});

beforeEach(() => {
  // Silence the structured logger â€” one JSON line per request
  // would flood the test output otherwise.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  // Reset every module-scope cache so tests cannot poison each
  // other through the worker-isolate pools.
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
  // Default: idempotency lookups miss, stores succeed.
  dbMocks.lookup.mockResolvedValue(null);
  dbMocks.store.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  App builder                                                        */
/* ------------------------------------------------------------------ */

/**
 * Compose an integration app seeded with two studios. The returned
 * tuple carries pre-signed bearer tokens for Alice (member / Studio
 * A), Bob (member / Studio B) and the Studio-A admin so each test
 * reads like a scripted journey rather than a re-signing ceremony.
 *
 * The `classes.updateClass` stub is deliberately overridden here to
 * simulate post-RLS cross-tenant invisibility: the admin's studio id
 * is compared against the target class's studio id and any mismatch
 * collapses to `not_found` â€” the same outcome RLS produces in
 * production when a `SET LOCAL app.studio_id = A` transaction
 * queries a row owned by Studio B.
 */
async function makeTwoStudioApp(): Promise<{
  readonly state: IntegrationState;
  readonly deps: DomainDeps;
  readonly app: ReturnType<typeof buildIntegrationApp>;
  readonly tokens: {
    readonly alice: string;
    readonly bob: string;
    readonly adminA: string;
  };
}> {
  const state = createIntegrationState();
  seedTwoStudios(state);

  const deps = buildIntegrationDeps({
    state,
    signSessionToken: async (u: UserRecord) =>
      signUserJwt(kp, {
        userId: u.userId,
        studioId: u.studioId,
        role: u.role,
      }),
  });

  // Override updateClass so the admin's studio-id is respected
  // against the class record in state. Default returns not_found
  // unconditionally; we want this suite to prove that the 404 is
  // caused by tenant mismatch (not by the class simply not
  // existing), which requires reading state.
  deps.classes.updateClass = vi.fn(async (studioId: string, classId: string) => {
    const cls = state.classes.get(classId);
    if (cls === undefined || cls.studioId !== studioId) {
      return { kind: 'not_found' as const };
    }
    // Happy path is NOT exercised by this suite â€” return the
    // class unchanged so the call is well-typed.
    return { kind: 'updated' as const, class: cls };
  });

  // Override `bookClass` so it simulates the post-RLS production
  // behaviour: a class whose `studio_id` does not match the
  // booker's studio is invisible (RLS read filter on `classes`)
  // and therefore appears as `class_not_found` to the service.
  // The default stub from `buildIntegrationDeps` only checks
  // `state.classes.has(classId)` and would happily let Bob book
  // a Studio-A class; this override is the slice B2 contract.
  deps.reservations.bookClass = vi.fn(
    async (
      claims: { readonly userId: string; readonly studioId: string },
      input: { readonly classId: string },
    ) => {
      const cls = state.classes.get(input.classId);
      if (cls === undefined) return { kind: 'not_found' as const };
      if (claims.studioId !== cls.studioId) {
        // Cross-tenant booking attempt — same outcome as a
        // missing class (Req 13.5: never disclose existence).
        return { kind: 'not_found' as const };
      }
      // We do not exercise the happy booking path here; return
      // a synthetic `not_found` for any other case so a wrong
      // assertion fails loudly rather than silently passing.
      return { kind: 'not_found' as const };
    },
  );

  // Override `listMembersByStudio` so admin A sees Studio A users
  // only (Alice + admin A, never Bob). The default stub returns
  // an empty page which would not catch a leak across studios.
  deps.members.listMembersByStudio = vi.fn(async (studioId: string) => {
    const items: Array<{
      id: string;
      studioId: string;
      displayName: string;
      email: string;
    }> = [];
    for (const u of state.users.values()) {
      if (u.studioId === studioId) {
        items.push({
          id: u.userId,
          studioId: u.studioId,
          displayName: u.displayName,
          email: u.email,
        });
      }
    }
    return { items, nextCursor: null };
  });

  // Override `updateProfile` / `updateConsents` so they touch ONLY
  // the caller's user record. The integration assertion downstream
  // verifies that Bob's row in `state.users` is unchanged after
  // Alice's PATCH â€” proving tenant isolation at the user-id level
  // (the route reads `claims.userId` directly, but a misconfigured
  // adapter could write to the wrong row).
  deps.members.updateProfile = vi.fn(
    async (userId: string, patch: { readonly displayName?: string }) => {
      const u = state.users.get(userId);
      if (u === undefined) {
        throw new Error('updateProfile: user not found');
      }
      if (patch.displayName !== undefined) {
        // Mutate in place â€” the existing UserRecord type has
        // `readonly` props so we cast to a writable view.
        (u as { displayName: string }).displayName = patch.displayName;
      }
      return {
        id: u.userId,
        email: u.email,
        displayName: u.displayName,
        studioId: u.studioId,
      };
    },
  );

  deps.members.updateConsents = vi.fn(async (userId: string, consents: Record<string, boolean>) => {
    const u = state.users.get(userId);
    if (u === undefined) {
      throw new Error('updateConsents: user not found');
    }
    return {
      userId: u.userId,
      ...consents,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
  });

  const app = buildIntegrationApp({ deps, jwksResolver: resolver });

  const [alice, bob, adminA] = await Promise.all([
    signUserJwt(kp, {
      userId: ALICE_ID,
      studioId: STUDIO_A_ID,
      role: 'member',
    }),
    signUserJwt(kp, {
      userId: BOB_ID,
      studioId: STUDIO_B_ID,
      role: 'member',
    }),
    signUserJwt(kp, {
      userId: ADMIN_A_ID,
      studioId: STUDIO_A_ID,
      role: 'admin',
    }),
  ]);

  return { state, deps, app, tokens: { alice, bob, adminA } };
}

/* ================================================================== */
/*  Suite                                                              */
/* ================================================================== */

describe('multi-tenant isolation â€” cross-tenant access surfaces 404', () => {
  /**
   * Req 13.2 / 13.5: `GET /v1/classes?from=&to=` returns classes
   * filtered to the caller's studio. Alice (Studio A) must NOT
   * observe Bob's class (Studio B) in the listing. The stub's
   * `listClasses(studioId)` filter mirrors the production RLS
   * predicate on `classes.studio_id`.
   */
  it("GET /v1/classes: Alice sees only Studio A classes (Bob's class is invisible)", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/classes?from=2099-01-01T00:00:00.000Z&to=2099-03-01T00:00:00.000Z',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect((body.items as any[])[0]!.id).toBe(CLASS_A_ID);
    expect((body.items as any[])[0]!.studioId).toBe(STUDIO_A_ID);
    // Critical: no Studio B leakage.
    expect((body.items as any[]).some((c) => c.studioId === STUDIO_B_ID)).toBe(false);
    expect((body.items as any[]).some((c) => c.id === CLASS_B_ID)).toBe(false);
  });

  /**
   * Req 13.3 / 13.5: `GET /v1/reservations/me` is scoped to
   * `app.user_id`. Alice must only observe her own reservation,
   * never Bob's â€” regardless of any shared class participation.
   */
  it("GET /v1/reservations/me (Alice): only Alice's reservation, no Bob leakage", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/reservations/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect((body.items as any[])[0]!.id).toBe(RESERVATION_A_ID);
    expect((body.items as any[])[0]!.userId).toBe(ALICE_ID);
    // Critical: Bob's reservation MUST NOT appear.
    expect((body.items as any[]).some((r) => r.id === RESERVATION_B_ID)).toBe(false);
    expect((body.items as any[]).some((r) => r.userId === BOB_ID)).toBe(false);
  });

  /**
   * Req 13.3 / 13.5: symmetry â€” Bob must not see Alice's
   * reservation either. The forward direction is already covered
   * above; this test guards against a stub that accidentally
   * widens for one user (e.g. a rogue default that returns all
   * reservations).
   */
  it("GET /v1/reservations/me (Bob): only Bob's reservation, no Alice leakage", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/reservations/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.bob}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect((body.items as any[])[0]!.id).toBe(RESERVATION_B_ID);
    expect((body.items as any[])[0]!.userId).toBe(BOB_ID);
    expect((body.items as any[]).some((r) => r.id === RESERVATION_A_ID)).toBe(false);
    expect((body.items as any[]).some((r) => r.userId === ALICE_ID)).toBe(false);
  });

  /**
   * Req 13.3 / 13.5: Alice attempting to cancel Bob's reservation
   * surfaces 404 `not_found` â€” NOT 403. A 403 would leak that the
   * reservation id exists in another tenant, which is exactly
   * what Req 13.5 forbids. The `cancelReservation` stub returns
   * `not_found` whenever the reservation's `userId` differs from
   * the caller's â€” the same outcome the post-RLS DELETE yields in
   * production when the row is invisible to the current
   * transaction.
   */
  it("DELETE /v1/reservations/:id (Alice â†’ Bob's reservation): 404 not_found (not 403)", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      `/v1/reservations/${RESERVATION_B_ID}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    await expectCrossTenantNotFound(res);
  });

  /**
   * Symmetry of the above â€” Bob cancelling Alice's reservation.
   */
  it("DELETE /v1/reservations/:id (Bob â†’ Alice's reservation): 404 not_found (not 403)", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      `/v1/reservations/${RESERVATION_A_ID}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokens.bob}` },
      },
      buildMockEnv(),
    );

    await expectCrossTenantNotFound(res);
  });

  /**
   * Req 13.2 / 13.5: Studio A's admin is correctly authenticated
   * AND has the `admin` role â€” so the 404 cannot be confused with
   * a role guard. The `updateClass` stub is overridden at
   * `makeTwoStudioApp` time to filter by studio id, mirroring the
   * post-RLS empty-row result when Admin A touches a Studio B
   * class.
   */
  it('PATCH /v1/classes/:id (admin A â†’ Studio B class): 404 not_found (not 403)', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      `/v1/classes/${CLASS_B_ID}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.adminA}`,
        },
        body: JSON.stringify({ title: 'Hacked Title', version: 1 }),
      },
      buildMockEnv(),
    );

    await expectCrossTenantNotFound(res);
  });

  /**
   * Req 13.2 / 13.3: `GET /v1/members/me` returns Alice's own
   * profile only. The route reads `authClaims.userId` directly
   * and the stub's `getProfile(userId)` lookup is scoped to the
   * single map entry â€” so tenant isolation is enforced by the
   * auth claim, not by a separate tenant filter.
   */
  it("GET /v1/members/me (Alice): returns only Alice's profile", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/members/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(ALICE_ID);
    expect(body.email).toBe('alice@studio-a.example');
    expect(body.displayName).toBe('Alice');
  });

  /**
   * Req 13.2 + 3.5 (role guard): `GET /v1/members` is admin/coach
   * only. Alice is a `member`, so the request is rejected with
   * 403 `forbidden` BEFORE the tenant filter runs.
   *
   * This is the ONE legitimate 403 in the suite. It does NOT
   * violate Req 13.5: the endpoint is forbidding based on ROLE,
   * not on the caller's inability to observe a specific row in
   * another tenant. The caller's role is self-evident from the
   * JWT â€” the server reveals nothing about Studio B by saying
   * "you don't have permission to list members".
   */
  it('GET /v1/members (Alice, member): 403 forbidden (role guard â€” NOT a cross-tenant leak)', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    // The collection endpoint is registered at `/v1/members`
    // (no trailing slash) â€” see `buildMembersRouter` mounting
    // `router.get('/', â€¦)` onto a Hono sub-router at `/v1/members`.
    // The trailing-slash variant `/v1/members/` hits the
    // global 404 handler, which is NOT what this assertion is
    // exercising.
    const res = await app.request(
      '/v1/members',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as any;
    expect(body.status).toBe(403);
    expect(body.title).toBe('forbidden');
    expect(body.traceId).toBe(res.headers.get('x-trace-id'));
  });

  /**
   * Req 13.2 / 13.5: a member of Studio B (Bob) cannot list
   * Studio A's classes either â€” the listing is scoped to Bob's
   * own studio. Complements the Alice case above by proving the
   * filter is symmetric.
   */
  it("GET /v1/classes (Bob): sees only Studio B classes (Alice's class is invisible)", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/classes?from=2099-01-01T00:00:00.000Z&to=2099-03-01T00:00:00.000Z',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.bob}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect((body.items as any[])[0]!.id).toBe(CLASS_B_ID);
    expect((body.items as any[])[0]!.studioId).toBe(STUDIO_B_ID);
    expect((body.items as any[]).some((c) => c.studioId === STUDIO_A_ID)).toBe(false);
    expect((body.items as any[]).some((c) => c.id === CLASS_A_ID)).toBe(false);
  });

  /* ============================================================== */
  /*  Slice B2 â€” additional cross-tenant assertions for endpoints    */
  /*  shipped in Niveau 2 (POST /v1/reservations, PATCH /v1/me,      */
  /*  PATCH /v1/me/consents, GET /v1/members admin path).            */
  /* ============================================================== */

  /**
   * B2.5 #1 â€” Req 13.5: Bob (Studio B) attempts to book Class A
   * (Studio A). Post-RLS production behaviour: the class row is
   * invisible to Bob's transaction (`classes_read_same_studio`
   * policy) so the booking service receives `class_not_found`
   * and surfaces 404 with `not_found`. We do NOT leak the fact
   * that Class A exists in Studio A â€” Req 13.5 is explicit.
   */
  it('POST /v1/reservations (Bob â†’ Class A in Studio A): 404 not_found (cross-tenant invisibility)', async () => {
    const { app, deps, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/reservations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.bob}`,
        },
        body: JSON.stringify({ classId: CLASS_A_ID }),
      },
      buildMockEnv(),
    );

    await expectCrossTenantNotFound(res);
    // Defense-in-depth: confirm the booking service was actually
    // invoked with Bob's userId (the route reached the deps) and
    // returned not_found â€” this rules out a route-layer 404
    // masking a tenant-scope bug deeper in the stack.
    expect(deps.reservations.bookClass).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BOB_ID, studioId: STUDIO_B_ID }),
      { classId: CLASS_A_ID },
    );
  });

  /**
   * B2.5 #2 â€” Req 13.3 / 13.5: explicit re-statement of the
   * cross-user cancel guarantee against `RESERVATION_B_ID` from
   * Alice's seat. The earlier `DELETE` test asserts the same
   * outcome; this one focuses on the response body shape so a
   * future regression that swaps `not_found` for a generic 500
   * is caught.
   */
  it("DELETE /v1/reservations/:id (Alice â†’ Bob's reservation): exact Problem Details envelope", async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      `/v1/reservations/${RESERVATION_B_ID}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.code).toBe('not_found');
    expect(body.detail).toBe('reservation not found');
  });

  /**
   * B2.5 #3 â€” Req 13.3 / 13.5: `GET /v1/reservations/me` filtered
   * by an explicit `from` / `to` window. Alice's window-scoped
   * listing must still exclude Bob's reservation: the userId
   * filter is the primary guard, the date range is orthogonal.
   * Catches a regression where the list adapter would forget the
   * `userId` predicate when both date bounds are present.
   */
  it('GET /v1/reservations/me?from=â€¦&to=â€¦ (Alice): userId filter survives date range', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/reservations/me?from=2099-01-01T00:00:00.000Z&to=2099-12-31T00:00:00.000Z',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect((body.items as any[]).every((r) => r.userId === ALICE_ID)).toBe(true);
    expect((body.items as any[]).some((r) => r.id === RESERVATION_B_ID)).toBe(false);
  });

  /**
   * B2.5 #4 â€” Req 3.2 / 13.5: `PATCH /v1/me` patches the
   * authenticated user's profile only â€” the route never accepts a
   * target user id. Proving this requires confirming Bob's row
   * stays untouched after Alice's PATCH, which is the strongest
   * guarantee a stub-based suite can give without a live DB.
   */
  it('PATCH /v1/members/me (Alice): mutates Alice only, Bob untouched', async () => {
    const { app, deps, state, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/members/me',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.alice}`,
        },
        body: JSON.stringify({ displayName: 'Alice Renamed' }),
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    // The override calls `updateProfile(claims.userId, patch)`
    // with the JWT claim â€” never Bob's userId. The state-level
    // assertion below proves the mutation landed on Alice and
    // not on Bob (defense in depth around the userId argument).
    expect(deps.members.updateProfile).toHaveBeenCalledWith(ALICE_ID, {
      displayName: 'Alice Renamed',
    });
    expect(state.users.get(ALICE_ID)!.displayName).toBe('Alice Renamed');
    expect(state.users.get(BOB_ID)!.displayName).toBe('Bob');
  });

  /**
   * B2.5 #5 â€” Req 3.3 / 13.5: `PATCH /v1/me/consents` follows
   * the same own-only contract as `PATCH /v1/me`. Verify that the
   * authenticated user's claim drives the call, never a client-
   * supplied userId.
   */
  it('PATCH /v1/members/me/consents (Bob): drives consents update for Bob only', async () => {
    const { app, deps, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/members/me/consents',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.bob}`,
        },
        body: JSON.stringify({
          marketing: true,
          analytics: false,
          thirdParty: false,
        }),
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    expect(deps.members.updateConsents).toHaveBeenCalledWith(BOB_ID, {
      marketing: true,
      analytics: false,
      thirdParty: false,
    });
    // Alice must NOT have been touched.
    const calls = deps.members.updateConsents as unknown as {
      mock: { calls: Array<[string, unknown]> };
    };
    expect(calls.mock.calls.some((args) => args[0] === ALICE_ID)).toBe(false);
  });

  /**
   * B2.5 #6 â€” Req 3.5 / 13.2 / 13.5: admin A lists members. The
   * page contains Studio A users only (Alice + admin A); Bob
   * (Studio B) MUST NOT appear. The override on
   * `listMembersByStudio` filters by `studioId` to mirror the
   * post-RLS behaviour of the `users_read_same_studio` policy.
   */
  it('GET /v1/members (Admin A, admin): Studio A users only — Bob absent', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/members',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.adminA}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const items = body.items as Array<{ id: string; studioId: string }>;
    expect(items).toHaveLength(2);
    expect(items.every((u) => u.studioId === STUDIO_A_ID)).toBe(true);
    expect(items.some((u) => u.id === BOB_ID)).toBe(false);
    const ids = items.map((u) => u.id);
    expect(ids).toContain(ALICE_ID);
    expect(ids).toContain(ADMIN_A_ID);
  });

  /**
   * B9.1 â€” Req 13.2 / 13.5: `GET /v1/studios/me` returns the
   * caller's tenant root row only. Alice (Studio A) sees Studio A,
   * Bob (Studio B) sees Studio B; neither can see the sibling row.
   * The route reads `claims.studioId` directly so cross-tenant
   * disclosure is impossible from the wire â€” this test guards
   * against a future regression where a query parameter might
   * override that scope.
   */
  it('GET /v1/studios/me (Alice): returns Studio A only, never Studio B', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/studios/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.alice}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(STUDIO_A_ID);
    expect(body.slug).toBe('athlya-paris');
    expect(body.brandColor).toBe('#0EA5E9');
    expect(body.id).not.toBe(STUDIO_B_ID);
  });

  /**
   * B9.1 â€” Req 13.5 symmetry: Bob (Studio B) sees Studio B only.
   */
  it('GET /v1/studios/me (Bob): returns Studio B only, never Studio A', async () => {
    const { app, tokens } = await makeTwoStudioApp();

    const res = await app.request(
      '/v1/studios/me',
      {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.bob}` },
      },
      buildMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(STUDIO_B_ID);
    expect(body.slug).toBe('athlya-lyon');
    expect(body.id).not.toBe(STUDIO_A_ID);
  });
});

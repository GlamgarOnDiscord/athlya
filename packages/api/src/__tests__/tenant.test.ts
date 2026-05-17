/**
 * Unit tests for the tenant middleware helpers.
 *
 * Exercises the three exports of `../middleware/tenant.ts`:
 *
 *   1. {@link withTenantTx} — pulls `authClaims` off the context,
 *      delegates to the mocked `withTenant` from `@athlya/db`, and
 *      throws {@link MissingAuthClaimsError} when claims are absent.
 *   2. {@link notFoundOnEmpty} — returns the first row on a non-empty
 *      array, throws {@link TenantResourceNotFoundError} on empty.
 *   3. {@link tenantErrorToProblem} — returns a 404 Problem Details
 *      body for {@link TenantResourceNotFoundError}, `null` for
 *      anything else.
 *
 * The `@athlya/db` module is replaced with a partial `vi.mock` so the
 * tests never hit a real Postgres connection. `vi.hoisted` keeps the
 * mock functions addressable from within the test bodies — required
 * because `vi.mock` is hoisted above the `import` statements.
 *
 * Validates: Requirements 13.1, 13.5.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTenantDbCache,
  MissingAuthClaimsError,
  notFoundOnEmpty,
  TenantResourceNotFoundError,
  tenantErrorToProblem,
  withTenantTx,
  type TenantMiddlewareContext,
} from '../middleware/tenant.js';

import type { TenantClaims } from '@athlya/db';

/* ------------------------------------------------------------------ */
/*  @athlya/db mock                                                    */
/* ------------------------------------------------------------------ */

/**
 * `vi.hoisted` runs BEFORE `vi.mock`, so the mock module factory can
 * close over the generated `vi.fn()`s. This pattern mirrors the one
 * used in `publish.test.ts` and `idempotency.test.ts` — do not inline
 * the functions into the factory, hoisting breaks the reference.
 */
const dbMocks = vi.hoisted(() => ({
  createDb: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock('@athlya/db', () => ({
  createDb: dbMocks.createDb,
  withTenant: dbMocks.withTenant,
}));

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Branded sentinel representing the pooled Drizzle client. */
const FAKE_DB = { __brand: 'fake-db' };

/** Branded sentinel representing a transactional Drizzle handle. */
const FAKE_TX = { __brand: 'fake-tx' };

/** A valid, well-formed {@link TenantClaims} fixture. */
const CLAIMS: TenantClaims = {
  userId: '00000000-0000-4000-8000-000000000001',
  studioId: '00000000-0000-4000-8000-0000000000a0',
  role: 'member',
};

/**
 * Build a minimal {@link TenantMiddlewareContext} double.
 *
 * `variables` is a plain record mapping keys to values. Passing
 * `undefined` for `authClaims` models the case where the auth
 * middleware from task 8.2 did not run ahead of us.
 */
function fakeContext(
  variables: Record<string, unknown>,
  env: { DB_URL: string } = { DB_URL: 'postgres://test' },
): TenantMiddlewareContext {
  return {
    get: (key: string): unknown => variables[key],
    env,
  };
}

/* ------------------------------------------------------------------ */
/*  Global setup                                                       */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  dbMocks.createDb.mockReset();
  dbMocks.withTenant.mockReset();
  dbMocks.createDb.mockReturnValue(FAKE_DB);
  // Default `withTenant` behaviour: invoke the callback with the
  // fake transaction and forward whatever it returns. Individual
  // tests can override via `mockImplementationOnce`.
  dbMocks.withTenant.mockImplementation(
    async (_db: unknown, _claims: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(FAKE_TX),
  );
  __resetTenantDbCache();
});

/* ================================================================== */
/*  withTenantTx                                                       */
/* ================================================================== */

describe('withTenantTx', () => {
  it('pulls authClaims off the context and forwards them to withTenant', async () => {
    const c = fakeContext({ authClaims: CLAIMS });
    const callback = vi.fn(async () => 'result');

    const out = await withTenantTx(c, callback);

    expect(out).toBe('result');
    expect(dbMocks.withTenant).toHaveBeenCalledTimes(1);
    expect(dbMocks.withTenant).toHaveBeenCalledWith(FAKE_DB, CLAIMS, expect.any(Function));
    // The callback received the transactional handle emitted by
    // the mocked `withTenant` implementation.
    expect(callback).toHaveBeenCalledWith(FAKE_TX);
  });

  it('lazily creates the Drizzle client the first time and caches it for subsequent calls', async () => {
    const c = fakeContext({ authClaims: CLAIMS });
    await withTenantTx(c, async () => 1);
    await withTenantTx(c, async () => 2);

    // `createDb` must only fire once — the second request hits the
    // module-level cache. This is the whole point of the cache: a
    // Worker isolate should not pay the client-construction cost
    // on every request.
    expect(dbMocks.createDb).toHaveBeenCalledTimes(1);
    expect(dbMocks.createDb).toHaveBeenCalledWith('postgres://test');
  });

  it('keys the client cache by DB_URL so two distinct envs do not share a pool', async () => {
    await withTenantTx(
      fakeContext({ authClaims: CLAIMS }, { DB_URL: 'postgres://dev' }),
      async () => 1,
    );
    await withTenantTx(
      fakeContext({ authClaims: CLAIMS }, { DB_URL: 'postgres://staging' }),
      async () => 2,
    );

    expect(dbMocks.createDb).toHaveBeenCalledTimes(2);
    expect(dbMocks.createDb).toHaveBeenNthCalledWith(1, 'postgres://dev');
    expect(dbMocks.createDb).toHaveBeenNthCalledWith(2, 'postgres://staging');
  });

  it('throws MissingAuthClaimsError when authClaims is undefined', async () => {
    const c = fakeContext({});
    const callback = vi.fn();

    await expect(withTenantTx(c, callback)).rejects.toBeInstanceOf(MissingAuthClaimsError);
    // The DB must never be touched when the guard trips.
    expect(dbMocks.createDb).not.toHaveBeenCalled();
    expect(dbMocks.withTenant).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('throws MissingAuthClaimsError when authClaims is explicitly null', async () => {
    // Belt-and-braces: task 8.2 would never write `null`, but a
    // future middleware could. Treat it the same as `undefined`.
    const c = fakeContext({ authClaims: null });

    await expect(withTenantTx(c, vi.fn())).rejects.toBeInstanceOf(MissingAuthClaimsError);
  });

  it('surfaces a stable `code` on MissingAuthClaimsError for Problem Details mapping', () => {
    const err = new MissingAuthClaimsError();
    expect(err.code).toBe('missing_auth_claims');
    expect(err.name).toBe('MissingAuthClaimsError');
  });

  it('propagates errors thrown by the caller-supplied callback', async () => {
    const c = fakeContext({ authClaims: CLAIMS });
    const boom = new Error('domain failure');

    await expect(
      withTenantTx(c, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('propagates errors thrown by the underlying withTenant call', async () => {
    const c = fakeContext({ authClaims: CLAIMS });
    const driverError = new Error('driver blew up');
    dbMocks.withTenant.mockRejectedValueOnce(driverError);

    await expect(withTenantTx(c, vi.fn())).rejects.toBe(driverError);
  });
});

/* ================================================================== */
/*  notFoundOnEmpty                                                    */
/* ================================================================== */

describe('notFoundOnEmpty', () => {
  it('returns the first row on a single-element array', () => {
    const row = { id: 'r1' };
    expect(notFoundOnEmpty([row])).toBe(row);
  });

  it('returns the first row when the array has multiple elements (caller limits arity)', () => {
    // This helper does not enforce `LIMIT 1`. That is the caller's
    // responsibility — downstream we may intentionally pass a
    // two-row array (e.g. batched reads) and want the head.
    const rows = [{ id: 'r1' }, { id: 'r2' }];
    expect(notFoundOnEmpty(rows)).toEqual({ id: 'r1' });
  });

  it('throws TenantResourceNotFoundError on an empty array', () => {
    expect(() => notFoundOnEmpty([])).toThrow(TenantResourceNotFoundError);
  });

  it('uses the supplied detail on the thrown error when provided', () => {
    try {
      notFoundOnEmpty([], 'reservation 123');
      expect.unreachable('notFoundOnEmpty should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TenantResourceNotFoundError);
      expect((err as TenantResourceNotFoundError).message).toBe('reservation 123');
    }
  });

  it('falls back to the default detail when none is supplied', () => {
    try {
      notFoundOnEmpty([]);
      expect.unreachable('notFoundOnEmpty should have thrown');
    } catch (err) {
      expect((err as TenantResourceNotFoundError).message).toBe('resource not found');
      expect((err as TenantResourceNotFoundError).code).toBe('not_found');
    }
  });
});

/* ================================================================== */
/*  tenantErrorToProblem                                               */
/* ================================================================== */

describe('tenantErrorToProblem', () => {
  it('returns a 404 Problem Details body for TenantResourceNotFoundError', () => {
    const err = new TenantResourceNotFoundError('reservation 42');
    const problem = tenantErrorToProblem(err);

    expect(problem).toEqual({
      status: 404,
      body: {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'reservation 42',
        code: 'not_found',
      },
    });
  });

  it('returns null for an unrelated Error instance', () => {
    expect(tenantErrorToProblem(new Error('boom'))).toBeNull();
  });

  it('returns null for MissingAuthClaimsError (task 8.5 handles it via a different mapper)', () => {
    // MissingAuthClaimsError is intentionally NOT handled here —
    // it's a wiring / programmer error that task 8.2 and the
    // global fallback map to 401, not 404.
    expect(tenantErrorToProblem(new MissingAuthClaimsError())).toBeNull();
  });

  it('returns null for plain objects, strings, and non-Error thrown values', () => {
    expect(tenantErrorToProblem({ code: 'not_found' })).toBeNull();
    expect(tenantErrorToProblem('not_found')).toBeNull();
    expect(tenantErrorToProblem(undefined)).toBeNull();
    expect(tenantErrorToProblem(null)).toBeNull();
  });

  it('preserves the Problem Details title as the HTTP status phrase', () => {
    const problem = tenantErrorToProblem(new TenantResourceNotFoundError());
    expect(problem?.body.title).toBe('Not Found');
    expect(problem?.body.status).toBe(404);
    expect(problem?.status).toBe(404);
  });
});

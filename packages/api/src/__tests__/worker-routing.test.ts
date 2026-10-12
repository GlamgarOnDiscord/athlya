/**
 * Bulkhead Worker routing verification (issue #230, CN.6.3).
 *
 * Verifies that each sub-worker entry point mounts exactly its own
 * domain routes and returns 404 for routes owned by the other Workers.
 * Uses Hono's in-process app.request() helper — no Wrangler or Docker needed.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import type { Hono } from 'hono';

import { app as authApp } from '../workers/auth.js';
import { app as reservationsApp } from '../workers/reservations.js';
import { app as billingApp } from '../workers/billing.js';

import { buildMockEnv } from './helpers/test-app.js';

import type { HonoEnv } from '../types.js';

const ENV = buildMockEnv({ ENVIRONMENT: 'dev' });

async function status(app: Hono<HonoEnv>, path: string, method = 'GET'): Promise<number> {
  const res = await app.request(new Request(`http://localhost${path}`, { method }), undefined, ENV);
  return res.status;
}

// ---------------------------------------------------------------------------
// Auth Worker
// ---------------------------------------------------------------------------

describe('auth worker', () => {
  it('serves /v1/auth/* (not 404)', async () => {
    // POST /v1/auth/login will 422 (missing body) or 401 but NOT 404.
    const s = await status(authApp, '/v1/auth/login', 'POST');
    expect(s).not.toBe(404);
  });

  it('returns 404 for /v1/billing/* (billing worker route)', async () => {
    const s = await status(authApp, '/v1/billing/invoices');
    expect(s).toBe(404);
  });

  it('returns 404 for /v1/reservations/* (reservations worker route)', async () => {
    const s = await status(authApp, '/v1/reservations');
    expect(s).toBe(404);
  });

  it('serves /health', async () => {
    const s = await status(authApp, '/health');
    expect(s).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Reservations Worker
// ---------------------------------------------------------------------------

describe('reservations worker', () => {
  it('serves /v1/classes/* (not 404)', async () => {
    // GET /v1/classes — 401 (no JWT) but NOT 404.
    const s = await status(reservationsApp, '/v1/classes');
    expect(s).not.toBe(404);
  });

  it('serves /v1/reservations/* (not 404)', async () => {
    const s = await status(reservationsApp, '/v1/reservations');
    expect(s).not.toBe(404);
  });

  it('serves /v1/members/* (not 404)', async () => {
    const s = await status(reservationsApp, '/v1/members/me');
    expect(s).not.toBe(404);
  });

  it('returns 404 for /v1/auth/* (auth worker route)', async () => {
    const s = await status(reservationsApp, '/v1/auth/login', 'POST');
    expect(s).toBe(404);
  });

  it('returns 404 for /v1/billing/* (billing worker route)', async () => {
    const s = await status(reservationsApp, '/v1/billing/invoices');
    expect(s).toBe(404);
  });

  it('serves /health', async () => {
    const s = await status(reservationsApp, '/health');
    expect(s).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Billing Worker
// ---------------------------------------------------------------------------

describe('billing worker', () => {
  it('serves /v1/billing/* (not 404)', async () => {
    // GET /v1/billing/invoices — 401 (no JWT) but NOT 404.
    const s = await status(billingApp, '/v1/billing/invoices');
    expect(s).not.toBe(404);
  });

  it('serves /v1/audit/* (not 404)', async () => {
    const s = await status(billingApp, '/v1/audit');
    expect(s).not.toBe(404);
  });

  it('returns 404 for /v1/auth/* (auth worker route)', async () => {
    const s = await status(billingApp, '/v1/auth/login', 'POST');
    expect(s).toBe(404);
  });

  it('returns 404 for /v1/reservations/* (reservations worker route)', async () => {
    const s = await status(billingApp, '/v1/reservations');
    expect(s).toBe(404);
  });

  it('serves /health', async () => {
    const s = await status(billingApp, '/health');
    expect(s).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Route contract (issue #230): every wrangler route of a sub-worker must be
// served by that worker, and sub-workers must not bundle the monolith.
// ---------------------------------------------------------------------------

const SUB_WORKERS: ReadonlyArray<{ config: string; app: Hono<HonoEnv>; source: string }> = [
  { config: 'wrangler.auth.toml', app: authApp, source: 'src/workers/auth.ts' },
  {
    config: 'wrangler.reservations.toml',
    app: reservationsApp,
    source: 'src/workers/reservations.ts',
  },
  { config: 'wrangler.billing.toml', app: billingApp, source: 'src/workers/billing.ts' },
];

function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

/** Path prefixes of every `pattern = "host/prefix/*"` route in a wrangler config. */
function routePrefixes(config: string): string[] {
  const prefixes = [...readPackageFile(config).matchAll(/^pattern = "[^/"]+(\/[^"*]*)\*"$/gm)].map(
    (match) => (match[1] ?? '').replace(/\/$/, ''),
  );
  return [...new Set(prefixes)];
}

describe.each(SUB_WORKERS)('$config route contract', ({ config, app, source }) => {
  const prefixes = routePrefixes(config);

  it('declares at least one route', () => {
    expect(prefixes.length).toBeGreaterThan(0);
  });

  it.each(prefixes)('serves %s', (prefix) => {
    const served = app.routes.some(
      (route) => route.path === prefix || route.path.startsWith(`${prefix}/`),
    );
    expect(served).toBe(true);
  });

  it('does not import the monolith entry point', () => {
    expect(readPackageFile(source)).not.toMatch(/from '\.\.\/worker\.js'/);
  });
});

describe('base-app module', () => {
  it('imports no domain router or OpenAPI spec (bundle isolation)', () => {
    const baseApp = readPackageFile('src/base-app.ts');
    expect(baseApp).not.toMatch(/from '\.\/routes\/index\.js'/);
    expect(baseApp).not.toMatch(/from '\.\/openapi\//);
    expect(baseApp).not.toMatch(/from '\.\/worker\.js'/);
  });
});

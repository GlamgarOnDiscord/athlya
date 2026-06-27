/**
 * Bulkhead Worker routing verification (issue #230, CN.6.3).
 *
 * Verifies that each sub-worker entry point mounts exactly its own
 * domain routes and returns 404 for routes owned by the other Workers.
 * Uses Hono's in-process app.request() helper — no Wrangler or Docker needed.
 */

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

  it.todo('serves /v1/sessions/* (not 404) — pending issue #302 (sessions adapter)');

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

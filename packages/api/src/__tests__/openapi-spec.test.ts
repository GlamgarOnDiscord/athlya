/**
 * Smoke tests for CN.9.1 — GET /openapi.json.
 *
 * Verifies that the spec endpoint is reachable, returns a valid
 * OpenAPI 3.1.0 document, and exposes the expected route inventory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../worker.js';

import type { AthlyaBindings } from '../types.js';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

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
    JWT_JWKS_URL: '',
    VERSION: 'test',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Console silencing                                                  */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

/* ------------------------------------------------------------------ */
/*  GET /openapi.json                                                  */
/* ------------------------------------------------------------------ */

describe('GET /openapi.json', () => {
  it('returns 200 with a valid OpenAPI 3.1.0 document', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.openapi).toBe('3.1.0');
    expect(body.info).toBeDefined();
    expect((body.info as Record<string, unknown>).title).toBe('Athlya API');
  });

  it('exposes all expected route paths', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());

    const body = await res.json<{ paths: Record<string, unknown> }>();
    const paths = Object.keys(body.paths);

    const expected = [
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/auth/refresh',
      '/v1/auth/logout',
      '/v1/auth/logout-all',
      '/v1/auth/password-reset/request',
      '/v1/auth/password-reset/confirm',
      '/v1/auth/me',
      '/v1/members/me',
      '/v1/members/me/consents',
      '/v1/members/me/export',
      '/v1/members',
      '/v1/classes',
      '/v1/classes/{id}',
      '/v1/reservations',
      '/v1/reservations/{reservationId}',
      '/v1/reservations/me',
      '/v1/studios/me',
      '/v1/sessions',
      '/v1/sessions/me',
      '/v1/audit',
      '/v1/checkins',
      '/v1/billing/checkout',
      '/v1/billing/invoices',
      '/v1/billing/webhook',
    ];

    for (const path of expected) {
      expect(paths, `path ${path} missing from spec`).toContain(path);
    }
  });

  it('declares bearerAuth security scheme', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());

    const body = await res.json<Record<string, unknown>>();
    // bearerAuth may be inlined under components.securitySchemes or
    // top-level depending on @hono/zod-openapi version.
    const components = body['components'] as Record<string, unknown> | undefined;
    const securitySchemes = (components?.['securitySchemes'] ?? body['securitySchemes']) as
      | Record<string, unknown>
      | undefined;
    expect(securitySchemes).toBeDefined();
    expect(securitySchemes?.['bearerAuth']).toBeDefined();
    const scheme = securitySchemes?.['bearerAuth'] as Record<string, unknown>;
    expect(scheme['type']).toBe('http');
    expect(scheme['scheme']).toBe('bearer');
  });

  it('is reachable without an Authorization header', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());
    expect(res.status).toBe(200);
  });
});

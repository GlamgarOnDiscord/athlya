/**
 * Smoke tests for CN.9.1 — GET /openapi.json.
 *
 * Verifies that the spec endpoint is reachable, returns a valid
 * OpenAPI 3.1.0 document, and exposes the expected route inventory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../worker.js';

import { readJson } from './helpers/read-json.js';

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
    EVENTS_NOTIFICATIONS_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_NOTIFICATIONS_QUEUE'],
    EVENTS_RGPD_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as AthlyaBindings['EVENTS_RGPD_QUEUE'],
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
      '/v1/me/progression',
      '/v1/me/progression/cardio',
      '/v1/coach',
      '/v1/coach/ask',
      '/v1/audit',
      '/v1/checkins',
      '/v1/checkins/token',
      '/v1/billing/checkout',
      '/v1/billing/invoices',
      '/v1/billing/webhook',
      '/v1/programs',
      '/v1/programs/{id}',
      '/v1/programs/{id}/archive',
      '/v1/programs/{id}/subscription',
      '/v1/programs/subscriptions/me',
      '/v1/programs/today',
    ];

    for (const path of expected) {
      expect(paths, `path ${path} missing from spec`).toContain(path);
    }
  });

  it('documents the optional import source of POST /v1/sessions', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());
    const body = await res.json<{
      paths: Record<string, Record<string, unknown>>;
      components?: { schemas?: Record<string, unknown> };
    }>();
    const post = body.paths['/v1/sessions']?.['post'] as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
    };
    let schema = post.requestBody.content['application/json']?.schema ?? {};
    const ref = schema['$ref'];
    if (typeof ref === 'string') {
      schema = (body.components?.schemas?.[ref.split('/').pop() ?? ''] ?? {}) as Record<
        string,
        unknown
      >;
    }
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['source']).toBeDefined();
    expect(schema['required']).not.toContain('source');
    expect(JSON.stringify(properties['source'])).toContain('appleHealth');
  });

  it('declares bearerAuth security scheme', async () => {
    const app = buildApp();
    const res = await app.request('/openapi.json', { method: 'GET' }, mockEnv());

    const body = await res.json<Record<string, unknown>>();
    // bearerAuth may be inlined under components.securitySchemes or
    // top-level depending on @hono/zod-openapi version.
    const components = body['components'] as Record<string, unknown> | undefined;
    const securitySchemes = (components?.['securitySchemes'] ?? body['securitySchemes']) as
      Record<string, unknown> | undefined;
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

  it('documents the optional cardio summary of a workout session (issue #667)', async () => {
    const res = await buildApp().request('/openapi.json', { method: 'GET' }, mockEnv());
    interface JsonSchema {
      readonly properties?: Record<string, JsonSchema>;
      readonly required?: readonly string[];
      readonly enum?: readonly string[];
    }
    const body = await readJson<{
      paths: Record<
        string,
        {
          post?: {
            requestBody: { content: Record<string, { schema: JsonSchema }> };
            responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
          };
        }
      >;
    }>(res);
    const post = body.paths['/v1/sessions']?.post;
    const request = post?.requestBody.content['application/json']?.schema;
    const response = post?.responses['201']?.content['application/json']?.schema;

    for (const schema of [request, response]) {
      expect(schema?.properties?.cardio?.properties?.machine?.enum).toEqual([
        'indoorBike',
        'treadmill',
        'rower',
        'crossTrainer',
      ]);
      expect(schema?.required ?? []).not.toContain('cardio');
    }
  });
});

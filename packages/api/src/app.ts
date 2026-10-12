/**
 * Monolith gateway factory: the global middleware chain from
 * `./base-app.ts` plus every `/v1/*` domain router and the OpenAPI spec.
 */

import { buildBaseApp } from './base-app.js';
import { installDomainScope } from './domain-scope.js';
import { buildSpecApp } from './openapi/spec.js';
import { mountDomainRoutes, type DomainDeps } from './routes/index.js';

import type { HonoEnv } from './types.js';
import type { Hono } from 'hono';

/**
 * Options accepted by {@link buildApp}.
 *
 *   • `deps` — custom {@link DomainDeps} bundle to wire into
 *     {@link mountDomainRoutes}. When omitted, the lazy production
 *     facade from {@link installDomainScope} is used. Integration tests
 *     pass a `vi.fn()`-backed bundle here so the route handlers are
 *     exercised without a real adapter.
 */
export interface BuildAppOptions {
  readonly deps?: DomainDeps;
}

/**
 * Internal options surface used by the test helper to opt out of
 * mounting `/v1/*` domain routes. NOT part of {@link BuildAppOptions}:
 * a production caller passing the flag would boot a Worker that 404s on
 * every `/v1/*` request (Sprint 11 / Slice 11.1, critique C2.2). Only
 * `__tests__/helpers/test-app.ts#buildAppNoDomainRoutes` may set it.
 */
interface BuildAppInternalOptions extends BuildAppOptions {
  readonly skipDomainRoutes?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): Hono<HonoEnv> {
  return __buildAppInternal(options);
}

/**
 * Test seam shared by {@link buildApp} and the test helpers. The
 * double-underscore prefix signals "test-only".
 */
export function __buildAppInternal(options: BuildAppInternalOptions = {}): Hono<HonoEnv> {
  if (options.skipDomainRoutes === true) {
    return buildBaseApp();
  }
  return buildBaseApp({
    mountDomain: (app) => {
      // CN.9.1 — OpenAPI 3.1 spec served at /openapi.json. A dedicated
      // OpenAPIHono instance generates the spec from the shared Zod
      // schemas; only its /openapi.json handler is exposed so the spec
      // stubs never shadow the real domain routes.
      const specApp = buildSpecApp();
      app.get('/openapi.json', (c) => specApp.request('/openapi.json', undefined, c.env));
      mountDomainRoutes(app, options.deps ?? installDomainScope(app, 'gateway'));
    },
  });
}

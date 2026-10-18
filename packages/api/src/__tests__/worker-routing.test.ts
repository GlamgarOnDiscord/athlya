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

import { READINESS_PROBES, type ReadinessProbe } from '../base-app.js';
import { app as authApp, READINESS as AUTH_READINESS } from '../workers/auth.js';
import {
  app as reservationsApp,
  READINESS as RESERVATIONS_READINESS,
} from '../workers/reservations.js';
import { app as billingApp, READINESS as BILLING_READINESS } from '../workers/billing.js';

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
    // Middleware (`app.use`) registers with method ALL and would match a
    // prefix even when no router is mounted: count real handlers only.
    const served = app.routes.some(
      (route) =>
        route.method !== 'ALL' && (route.path === prefix || route.path.startsWith(`${prefix}/`)),
    );
    expect(served).toBe(true);
  });

  it('does not import the monolith entry point or the all-domain bundle', () => {
    const text = readPackageFile(source);
    expect(text).not.toMatch(/from '\.\.\/worker\.js'/);
    expect(text).not.toMatch(/from '\.\.\/app\.js'/);
    expect(text).not.toMatch(/from '\.\.\/routes\/index\.js'/);
  });

  it('serves /admin/* only when its wrangler config routes it', async () => {
    const routesAdmin = prefixes.includes('/admin');
    const s = await status(app, '/admin/jwt/state');
    if (routesAdmin) {
      expect(s).not.toBe(404);
    } else {
      expect(s).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Readiness contract (issue #614): each Worker's /health/ready probe list
// matches the bindings its wrangler config declares.
// ---------------------------------------------------------------------------

/** Bindings or secrets a probe reads. */
const PROBE_BINDINGS: Record<ReadinessProbe, readonly string[]> = {
  db: ['DB_URL'],
  redis: ['REDIS_URL', 'REDIS_TOKEN'],
  cron: ['CRON_DB_URL'],
  hyperdrive: ['HYPERDRIVE'],
  avatarsBucket: ['AVATARS_BUCKET'],
  exportsBucket: ['EXPORTS_BUCKET'],
  auditLogPartitions: ['DB_URL'],
  sentryDsn: ['SENTRY_DSN'],
};

/**
 * Probes that must be listed whenever their bindings are declared.
 * `auditLogPartitions` reuses `DB_URL`, so it is required only where
 * the Worker touches `audit_log`, and is checked one way only.
 */
const BINDING_BACKED_PROBES = READINESS_PROBES.filter((name) => name !== 'auditLogPartitions');

const SECRET_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu;

/** Secret names of a `# <label>` header block continued on `#   ` lines. */
function headerSecrets(toml: string, label: string): string[] {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`# ${label}`));
  if (start === -1) return [];
  const first = lines[start] ?? '';
  const block = [first.slice(first.indexOf(':') + 1)];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('#   ')) break;
    block.push(line);
  }
  return block.join(' ').match(SECRET_NAME) ?? [];
}

/** Secrets documented in the header plus every `binding = "…"` entry. */
function declaredBindings(config: string): Set<string> {
  const toml = readPackageFile(config);
  const bindings = [...toml.matchAll(/^binding = "([A-Z0-9_]+)"$/gm)].map((m) => m[1] ?? '');
  return new Set([
    ...headerSecrets(toml, 'Secrets (set once per env'),
    ...headerSecrets(toml, 'Production also'),
    ...bindings,
  ]);
}

const READINESS_WORKERS: ReadonlyArray<{
  config: string;
  readiness: readonly ReadinessProbe[];
}> = [
  { config: 'wrangler.toml', readiness: READINESS_PROBES },
  { config: 'wrangler.auth.toml', readiness: AUTH_READINESS },
  { config: 'wrangler.reservations.toml', readiness: RESERVATIONS_READINESS },
  { config: 'wrangler.billing.toml', readiness: BILLING_READINESS },
];

describe.each(READINESS_WORKERS)('$config readiness contract', ({ config, readiness }) => {
  const declared = declaredBindings(config);

  it('documents its secrets and bindings', () => {
    expect(declared.has('DB_URL')).toBe(true);
  });

  it.each([...readiness])('declares every binding the %s probe reads', (probe) => {
    const missing = PROBE_BINDINGS[probe].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it.each(BINDING_BACKED_PROBES)('requires %s when its bindings are declared', (probe) => {
    const bound = PROBE_BINDINGS[probe].every((name) => declared.has(name));
    expect(readiness.includes(probe)).toBe(bound);
  });
});

describe('base-app module', () => {
  it('imports no domain router, admin router or OpenAPI spec (bundle isolation)', () => {
    const baseApp = readPackageFile('src/base-app.ts');
    expect(baseApp).not.toMatch(/from '\.\/routes\/index\.js'/);
    expect(baseApp).not.toMatch(/from '\.\/admin\//);
    expect(baseApp).not.toMatch(/from '\.\/admin-routes\.js'/);
    expect(baseApp).not.toMatch(/from '\.\/openapi\//);
    expect(baseApp).not.toMatch(/from '\.\/worker\.js'/);
  });
});

describe.each(['src/domain-scope.ts', 'src/domain-deps.ts'])('%s', (source) => {
  it('does not import the router bundle (bundle isolation)', () => {
    const text = readPackageFile(source);
    expect(text).not.toMatch(/^import \{[^}]*\} from '\.\/routes\//m);
    expect(text).not.toMatch(/from '\.\/routes\/index\.js'/);
  });
});

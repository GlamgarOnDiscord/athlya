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

import { buildApp } from '../app.js';
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

  it('returns 404 for /v1/me/* (reservations worker route)', async () => {
    const s = await status(authApp, '/v1/me/progression');
    expect(s).toBe(404);
  });

  it('returns 404 for /v1/coach and /v1/coach/* (reservations worker routes)', async () => {
    expect(await status(authApp, '/v1/coach')).toBe(404);
    expect(await status(authApp, '/v1/coach/ask', 'POST')).toBe(404);
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

  it('serves /v1/me/progression (not 404)', async () => {
    const s = await status(reservationsApp, '/v1/me/progression');
    expect(s).not.toBe(404);
  });

  it('serves /v1/coach and /v1/coach/ask (not 404)', async () => {
    expect(await status(reservationsApp, '/v1/coach')).not.toBe(404);
    expect(await status(reservationsApp, '/v1/coach/ask', 'POST')).not.toBe(404);
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

  it('returns 404 for /v1/me/* (reservations worker route)', async () => {
    const s = await status(billingApp, '/v1/me/progression');
    expect(s).toBe(404);
  });

  it('returns 404 for /v1/coach and /v1/coach/* (reservations worker routes)', async () => {
    expect(await status(billingApp, '/v1/coach')).toBe(404);
    expect(await status(billingApp, '/v1/coach/ask', 'POST')).toBe(404);
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

/**
 * Path prefixes of every route in a wrangler config: `host/prefix/*`
 * and exact `host/prefix` patterns both yield `/prefix`.
 */
function routePrefixes(config: string): string[] {
  const prefixes = [...readPackageFile(config).matchAll(/^pattern = "[^/"]+(\/[^"*]*)\*?"$/gm)].map(
    (match) => (match[1] ?? '').replace(/\/$/, ''),
  );
  return [...new Set(prefixes)];
}

/** Every `pattern = "…"` value of a wrangler config. */
function routePatterns(config: string): string[] {
  return [...readPackageFile(config).matchAll(/^pattern = "([^"]+)"$/gm)].map((m) => m[1] ?? '');
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

  it('pairs every exact route with its /* route', () => {
    const patterns = routePatterns(config);
    for (const pattern of patterns.filter((p) => !p.endsWith('*'))) {
      expect(patterns).toContain(`${pattern}/*`);
    }
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
    ...headerSecrets(toml, 'Optional'),
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

// ---------------------------------------------------------------------------
// Binding drift (issue #625): a Worker that mounts a router binds the
// resources and sets the vars that router reads, in every environment of
// its wrangler config, exactly as the gateway does.
// ---------------------------------------------------------------------------

interface WranglerEnv {
  /** R2 binding name to bucket name. */
  r2: Map<string, string>;
  /** `[vars]` name to value. */
  vars: Map<string, string>;
}

const TABLE_HEADER = /^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;
const STRING_KEY = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/;

/**
 * R2 bindings and vars of a wrangler config text, keyed by environment
 * (`''` is the top level). Every environment the config declares is
 * present, bound or not.
 */
function parseWranglerEnvs(toml: string): Map<string, WranglerEnv> {
  const envs = new Map<string, WranglerEnv>();
  const envOf = (name: string): WranglerEnv => {
    const found = envs.get(name);
    if (found !== undefined) return found;
    const created: WranglerEnv = { r2: new Map(), vars: new Map() };
    envs.set(name, created);
    return created;
  };
  envOf('');
  let section: 'r2' | 'vars' | null = null;
  let env = '';
  let bucket: { binding?: string; name?: string } = {};
  const flushBucket = (): void => {
    if (bucket.binding !== undefined && bucket.name !== undefined) {
      envOf(env).r2.set(bucket.binding, bucket.name);
    }
    bucket = {};
  };
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      flushBucket();
      const table = (header[1] ?? '').trim();
      env = /^env\.([^.]+)/.exec(table)?.[1] ?? '';
      envOf(env);
      const local = env === '' ? table : table.slice(`env.${env}.`.length);
      section = local === 'r2_buckets' ? 'r2' : local === 'vars' ? 'vars' : null;
      continue;
    }
    const [, key, value] = STRING_KEY.exec(line) ?? [];
    if (section === null || key === undefined || value === undefined) continue;
    if (section === 'vars') envOf(env).vars.set(key, value);
    else if (key === 'binding') bucket.binding = value;
    else if (key === 'bucket_name') bucket.name = value;
  }
  flushBucket();
  return envs;
}

/** What a router reads from its Worker's env (`members-deps.ts`). */
interface RouterNeeds {
  prefix: string;
  /** R2 bindings, required in every env with the gateway's bucket. */
  r2: readonly string[];
  /** Vars, set in every env exactly as the gateway sets them (or unset). */
  vars: readonly string[];
  /** Secrets, listed in the wrangler `# Secrets` header. */
  secrets: readonly string[];
}

const ROUTER_NEEDS: readonly RouterNeeds[] = [
  {
    prefix: '/v1/members',
    r2: ['AVATARS_BUCKET', 'EXPORTS_BUCKET'],
    vars: ['AVATARS_PUBLIC_URL'],
    secrets: ['EXPORT_URL_SIGNING_KEY'],
  },
  {
    prefix: '/v1/coach',
    r2: [],
    vars: [],
    secrets: ['MISTRAL_API_KEY'],
  },
];

/** Every env where `worker` diverges from `gateway` on what `needs` reads. */
function routerDrift(
  worker: Map<string, WranglerEnv>,
  gateway: Map<string, WranglerEnv>,
  needs: RouterNeeds,
): string[] {
  const drift: string[] = [];
  for (const [env, bound] of worker) {
    const label = env === '' ? 'top level' : `env.${env}`;
    const reference = gateway.get(env);
    for (const name of needs.r2) {
      const bucket = bound.r2.get(name);
      const expected = reference?.r2.get(name);
      if (bucket === undefined) drift.push(`${label}: ${name} not bound`);
      else if (bucket !== expected) {
        drift.push(`${label}: ${name} = ${bucket}, gateway ${String(expected)}`);
      }
    }
    for (const name of needs.vars) {
      const value = bound.vars.get(name);
      const expected = reference?.vars.get(name);
      if (value !== expected) {
        drift.push(`${label}: var ${name} = ${String(value)}, gateway ${String(expected)}`);
      }
    }
  }
  return drift;
}

/** True when `app` has a real handler under `prefix`. */
function mounts(app: Hono<HonoEnv>, prefix: string): boolean {
  return app.routes.some(
    (route) =>
      route.method !== 'ALL' && (route.path === prefix || route.path.startsWith(`${prefix}/`)),
  );
}

const GATEWAY_CONFIG = 'wrangler.toml';

const BINDING_WORKERS: ReadonlyArray<{ config: string; app: Hono<HonoEnv> }> = [
  { config: GATEWAY_CONFIG, app: buildApp() },
  ...SUB_WORKERS.map(({ config, app }) => ({ config, app })),
];

describe.each(BINDING_WORKERS)('$config router bindings', ({ config, app }) => {
  const worker = parseWranglerEnvs(readPackageFile(config));
  const gateway = parseWranglerEnvs(readPackageFile(GATEWAY_CONFIG));

  it('parses at least the top-level and staging environments', () => {
    expect([...worker.keys()]).toEqual(expect.arrayContaining(['', 'staging']));
  });

  describe.each(ROUTER_NEEDS)('$prefix', (needs) => {
    const mounted = mounts(app, needs.prefix);

    it('binds its R2 buckets and sets its vars like the gateway in every env', () => {
      expect(mounted ? routerDrift(worker, gateway, needs) : []).toEqual([]);
    });

    it('documents the secrets it reads', () => {
      const declared = declaredBindings(config);
      const missing = mounted ? needs.secrets.filter((name) => !declared.has(name)) : [];
      expect(missing).toEqual([]);
    });
  });
});

describe('reservations Worker /v1/coach zone routes', () => {
  const patterns = routePatterns('wrangler.reservations.toml');

  it.each(['staging.api.athlya.app', 'api.athlya.app'])('routes %s/v1/coach and /*', (host) => {
    expect(patterns).toContain(`${host}/v1/coach`);
    expect(patterns).toContain(`${host}/v1/coach/*`);
  });
});

describe('router bindings check', () => {
  it('applies to the reservations Worker, which serves /v1/members', () => {
    expect(mounts(reservationsApp, '/v1/members')).toBe(true);
  });

  it('reports a missing bucket, a renamed bucket and a var that differs from the gateway', () => {
    const gateway = parseWranglerEnvs(
      [
        '[vars]',
        'AVATARS_PUBLIC_URL = "https://avatars.example"',
        '',
        '[[r2_buckets]]',
        'binding = "AVATARS_BUCKET"',
        'bucket_name = "athlya-avatars-dev"',
        '',
        '[[r2_buckets]]',
        'binding = "EXPORTS_BUCKET"',
        'bucket_name = "athlya-exports-dev"',
        '',
        '[[env.staging.r2_buckets]]',
        'binding = "AVATARS_BUCKET"',
        'bucket_name = "athlya-avatars-staging"',
        '',
        '[[env.staging.r2_buckets]]',
        'binding = "EXPORTS_BUCKET"',
        'bucket_name = "athlya-exports-staging"',
      ].join('\n'),
    );
    const worker = parseWranglerEnvs(
      [
        '[vars]',
        'ENVIRONMENT = "dev"',
        '',
        '[[r2_buckets]]',
        'binding = "AVATARS_BUCKET"',
        'bucket_name = "athlya-avatars-dev"',
        '',
        '[env.staging]',
        'name = "worker-staging"',
        '',
        '[[env.staging.r2_buckets]]',
        'binding = "AVATARS_BUCKET"',
        'bucket_name = "athlya-avatars-staging"',
        '',
        '[[env.staging.r2_buckets]]',
        'binding = "EXPORTS_BUCKET"',
        'bucket_name = "athlya-exports-production"',
        '',
        '[[env.staging.durable_objects.bindings]]',
        'name = "CLASS_CAPACITY_DO"',
      ].join('\n'),
    );
    const needs = ROUTER_NEEDS.find(({ prefix }) => prefix === '/v1/members');
    if (needs === undefined) throw new Error('no /v1/members needs');

    expect(routerDrift(worker, gateway, needs)).toEqual([
      'top level: EXPORTS_BUCKET not bound',
      'top level: var AVATARS_PUBLIC_URL = undefined, gateway https://avatars.example',
      'env.staging: EXPORTS_BUCKET = athlya-exports-production, gateway athlya-exports-staging',
    ]);
    expect(routerDrift(gateway, gateway, needs)).toEqual([]);
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

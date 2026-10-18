/**
 * `/health/ready` scoped per Worker (issue #614).
 *
 * Each bulkhead sub-worker runs only the readiness probes its own
 * bindings support: it is ready without the other Workers' bindings,
 * still fails when one of its own is missing, and the gateway keeps the
 * full probe set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ partitionsPresent: true }));

function partitionName(date: Date): string {
  return `audit_log_${String(date.getFullYear())}_${String(date.getMonth() + 1).padStart(2, '0')}`;
}

vi.mock('@athlya/db', () => ({
  pingDbHttp: vi.fn().mockResolvedValue(undefined),
  pingDb: vi.fn().mockResolvedValue(undefined),
  createNeonHttpSql: () => () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Promise.resolve(
      db.partitionsPresent ? [{ name: partitionName(now) }, { name: partitionName(next) }] : [],
    );
  },
}));

const { READINESS_PROBES } = await import('../base-app.js');
const { buildApp } = await import('../app.js');
const auth = await import('../workers/auth.js');
const reservations = await import('../workers/reservations.js');
const billing = await import('../workers/billing.js');

import { readJson } from './helpers/read-json.js';
import { buildMockEnv } from './helpers/test-app.js';

import type { ReadinessProbe } from '../base-app.js';
import type { AthlyaBindings, HonoEnv } from '../types.js';
import type { Hono } from 'hono';

interface ReadyBody {
  status: string;
  checks: Partial<Record<ReadinessProbe, { status: string; error?: string }>>;
}

const HYPERDRIVE = {
  connectionString: 'postgresql://app@hyperdrive.example/athlya',
} as unknown as NonNullable<AthlyaBindings['HYPERDRIVE']>;

/** Bindings each probe reads, removed one at a time below. */
const PROBE_BINDING: Record<ReadinessProbe, readonly (keyof AthlyaBindings)[]> = {
  db: ['DB_URL'],
  redis: ['REDIS_URL'],
  cron: ['CRON_DB_URL'],
  hyperdrive: ['HYPERDRIVE'],
  avatarsBucket: ['AVATARS_BUCKET'],
  exportsBucket: ['EXPORTS_BUCKET'],
  auditLogPartitions: [],
  sentryDsn: ['SENTRY_DSN'],
};

/** `env` without the bindings `probe` reads. */
function without(env: AthlyaBindings, probe: ReadinessProbe): AthlyaBindings {
  const copy: Partial<AthlyaBindings> = { ...env };
  for (const name of PROBE_BINDING[probe]) delete copy[name];
  return copy as AthlyaBindings;
}

/** Probes that also stop passing when a probe's binding is removed. */
const SHARED_BINDING: Partial<Record<ReadinessProbe, readonly ReadinessProbe[]>> = {
  db: ['auditLogPartitions'],
};

/** Listed probes expected to fail once `probe`'s binding is removed. */
function expectedFailures(
  probe: ReadinessProbe,
  readiness: readonly ReadinessProbe[],
): ReadinessProbe[] {
  const affected = [probe, ...(SHARED_BINDING[probe] ?? [])];
  return READINESS_PROBES.filter((name) => readiness.includes(name) && affected.includes(name));
}

/** Production env carrying only the core secrets every Worker shares. */
function coreEnv(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return buildMockEnv({
    ENVIRONMENT: 'production',
    CORS_ORIGIN: 'https://app.athlya.app',
    DB_URL: 'postgresql://app@db.example/athlya',
    REDIS_URL: 'https://redis.example',
    REDIS_TOKEN: 'token',
    SENTRY_DSN: 'https://key@o1.ingest.de.sentry.io/1',
    ...overrides,
  });
}

/** Production env with every binding the gateway reads. */
function gatewayEnv(): AthlyaBindings {
  return coreEnv({
    CRON_DB_URL: 'postgresql://athlya_cron@db.example/athlya',
    HYPERDRIVE,
    AVATARS_BUCKET: {} as NonNullable<AthlyaBindings['AVATARS_BUCKET']>,
    EXPORTS_BUCKET: {} as NonNullable<AthlyaBindings['EXPORTS_BUCKET']>,
  });
}

async function ready(app: Hono<HonoEnv>, env: AthlyaBindings): Promise<[number, ReadyBody]> {
  const res = await app.request(
    '/health/ready',
    { method: 'GET', headers: { host: 'api.athlya.app' } },
    env,
  );
  return [res.status, await readJson<ReadyBody>(res)];
}

/** Names of the checks that did not pass. */
function notOk(body: ReadyBody): string[] {
  return Object.entries(body.checks)
    .filter(([, result]) => result.status !== 'ok')
    .map(([name]) => name);
}

beforeEach(() => {
  db.partitionsPresent = true;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('PONG', { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SUB_WORKERS = [
  { name: 'auth', app: auth.app, readiness: auth.READINESS, env: () => coreEnv() },
  {
    name: 'reservations',
    app: reservations.app,
    readiness: reservations.READINESS,
    env: () => coreEnv({ HYPERDRIVE }),
  },
  { name: 'billing', app: billing.app, readiness: billing.READINESS, env: () => coreEnv() },
];

describe.each(SUB_WORKERS)('$name worker /health/ready', ({ app, readiness, env }) => {
  it('is ready without the other Workers bindings and reports only its own probes', async () => {
    const [status, body] = await ready(app, env());

    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(Object.keys(body.checks)).toEqual(
      READINESS_PROBES.filter((name) => readiness.includes(name)),
    );
  });

  it.each([...readiness])('is not ready when its own %s probe fails', async (probe) => {
    if (probe === 'auditLogPartitions') db.partitionsPresent = false;
    const [status, body] = await ready(app, without(env(), probe));

    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(['skipped', 'failed']).toContain(body.checks[probe]?.status);
    expect(notOk(body)).toEqual(expectedFailures(probe, readiness));
  });
});

describe('gateway /health/ready', () => {
  it('runs every probe and is ready with every binding', async () => {
    const [status, body] = await ready(buildApp(), gatewayEnv());

    expect(status).toBe(200);
    expect(Object.keys(body.checks)).toEqual([...READINESS_PROBES]);
  });

  it.each([...READINESS_PROBES])('is not ready when its %s probe fails', async (probe) => {
    if (probe === 'auditLogPartitions') db.partitionsPresent = false;
    const [status, body] = await ready(buildApp(), without(gatewayEnv(), probe));

    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(['skipped', 'failed']).toContain(body.checks[probe]?.status);
    expect(notOk(body)).toEqual(expectedFailures(probe, READINESS_PROBES));
  });

  it('is not ready with only a sub-worker binding set', async () => {
    const [status, body] = await ready(buildApp(), coreEnv());

    expect(status).toBe(503);
    expect(body.checks.cron?.status).toBe('skipped');
    expect(body.checks.avatarsBucket?.status).toBe('skipped');
  });
});

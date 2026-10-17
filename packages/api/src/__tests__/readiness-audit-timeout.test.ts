/**
 * `/health/ready` — the audit-log partition probe is bounded by the
 * same 2-second deadline as the other DB probes, so a hung Postgres
 * cannot lock up the readiness gate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@athlya/db', () => ({
  pingDbHttp: vi.fn().mockResolvedValue(undefined),
  pingDb: vi.fn().mockResolvedValue(undefined),
  createNeonHttpSql: () => () => new Promise<never>(() => undefined),
}));

const { buildApp } = await import('../app.js');

import { buildMockEnv } from './helpers/test-app.js';

import { readJson } from './helpers/read-json.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('/health/ready audit partition probe', () => {
  it('fails after 2 seconds when the partition query hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const app = buildApp();

    const pending = app.request(
      '/health/ready',
      { method: 'GET', headers: { host: 'localhost:8787' } },
      buildMockEnv({ ENVIRONMENT: 'dev', DB_URL: 'postgresql://app@db.example/athlya' }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const res = await pending;

    expect(res.status).toBe(503);
    const body = await readJson<{
      checks: { auditLogPartitions: { status: string; error?: string } };
    }>(res);
    expect(body.checks.auditLogPartitions.status).toBe('failed');
    expect(body.checks.auditLogPartitions.error).toMatch(/timeout/);
  });
});

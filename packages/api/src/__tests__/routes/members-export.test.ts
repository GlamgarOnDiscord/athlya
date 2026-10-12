/**
 * `GET /v1/members/me/export/:jobId` and `.../download` (issue #498).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import { readJson } from '../helpers/read-json.js';

import {
  buildLocalResolver,
  buildStubDeps,
  env,
  mintTestKeypair,
  signTestJwt,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  type TestKeypair,
} from './route-test-helpers.js';

import type { JwksKeyResolver } from '../../middleware/auth.js';

const joseHoisted = vi.hoisted(() => ({
  localResolver: null as JwksKeyResolver | null,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    createRemoteJWKSet: () =>
      (async (...args: Parameters<JwksKeyResolver>) => {
        if (joseHoisted.localResolver === null) {
          throw new Error('local resolver not initialised');
        }
        return joseHoisted.localResolver(...args);
      }) as JwksKeyResolver,
  };
});

const JOB_ID = '0193f000-0000-7000-8000-000000000498';
let kp: TestKeypair;

beforeAll(async () => {
  kp = await mintTestKeypair();
  joseHoisted.localResolver = buildLocalResolver(kp.publicJwk);
});

beforeEach(() => {
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
  __resetJwksCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function auth(): Promise<Record<string, string>> {
  const token = await signTestJwt(kp.privateKey, {
    sub: TEST_USER_ID,
    studio: TEST_STUDIO_ID,
    role: 'member',
  });
  return { authorization: `Bearer ${token}` };
}

describe('GET /v1/members/me/export/:jobId', () => {
  it('returns 401 without Authorization', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(`/v1/members/me/export/${JOB_ID}`, {}, env());
    expect(res.status).toBe(401);
    expect(deps.members.getExportJob).not.toHaveBeenCalled();
  });

  it('returns 422 for a non-uuid job id', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      '/v1/members/me/export/not-a-uuid',
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
  });

  it('returns 404 when the job is not the caller’s', async () => {
    const deps = buildStubDeps({ members: { getExportJob: vi.fn(async () => null) } });
    const res = await buildApp({ deps }).request(
      `/v1/members/me/export/${JOB_ID}`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it('returns the job status', async () => {
    const view = {
      jobId: JOB_ID,
      status: 'completed' as const,
      requestedAt: '2026-10-12T00:00:00.000Z',
      completedAt: '2026-10-12T00:01:00.000Z',
      error: null,
      downloadUrl: 'https://api.athlya.test/v1/members/me/export/x/download?exp=1&sig=s',
      downloadExpiresAt: '2026-10-15T00:01:00.000Z',
    };
    const getExportJob = vi.fn(async () => view);
    const deps = buildStubDeps({ members: { getExportJob } });
    const res = await buildApp({ deps }).request(
      `/v1/members/me/export/${JOB_ID}`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(200);
    expect(await readJson<typeof view>(res)).toEqual(view);
    expect(getExportJob).toHaveBeenCalledWith(
      JOB_ID,
      expect.objectContaining({ userId: TEST_USER_ID }),
    );
  });
});

describe('GET /v1/members/me/export/:jobId/download', () => {
  const path = `/v1/members/me/export/${JOB_ID}/download?exp=4102444800&sig=abc`;

  it('requires the owner JWT even with a signed link', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(path, {}, env());
    expect(res.status).toBe(401);
    expect(deps.members.openExportDownload).not.toHaveBeenCalled();
  });

  it('returns 422 without exp / sig', async () => {
    const deps = buildStubDeps();
    const res = await buildApp({ deps }).request(
      `/v1/members/me/export/${JOB_ID}/download`,
      { headers: await auth() },
      env(),
    );
    expect(res.status).toBe(422);
  });

  it.each([
    ['invalid_link', 403, 'export_link_invalid'],
    ['not_found', 404, 'export_not_found'],
    ['not_configured', 503, 'export_download_not_configured'],
  ] as const)('maps %s to %i', async (kind, status, code) => {
    const deps = buildStubDeps({
      members: { openExportDownload: vi.fn(async () => ({ kind })) },
    });
    const res = await buildApp({ deps }).request(path, { headers: await auth() }, env());
    expect(res.status).toBe(status);
    expect((await readJson<{ code: string }>(res)).code).toBe(code);
  });

  it('streams the archive as a private attachment', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const openExportDownload = vi.fn(async () => ({
      kind: 'ok' as const,
      body: new Response(bytes).body!,
      size: bytes.length,
    }));
    const deps = buildStubDeps({ members: { openExportDownload } });
    const res = await buildApp({ deps }).request(path, { headers: await auth() }, env());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-disposition')).toContain(`athlya-export-${JOB_ID}.zip`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(openExportDownload).toHaveBeenCalledWith(
      JOB_ID,
      4102444800,
      'abc',
      expect.objectContaining({ userId: TEST_USER_ID }),
    );
  });
});

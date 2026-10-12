import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createExportDataSource,
  EXPORT_JOB_NOT_CLAIMED_REASON,
} from '../../adapters/export-data-source.js';
import { buildBlobStore, EXPORTS_BUCKET_MISSING_REASON } from '../../adapters/export-deps.js';
import {
  EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON,
  buildExportDownloadUrl,
  signExportDownload,
  verifyExportDownload,
} from '../../adapters/export-download.js';
import { createExportJobWorkerStore } from '../../adapters/members-export-job-store-drizzle.js';

import type { AthlyaBindings } from '../../types.js';
import type { AthlyaDbAny } from '@athlya/db/client';
import type { R2Bucket } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';

/** Issue #498 — export worker adapters. */

const SECRET = 'k'.repeat(48);
const JOB_ID = '0193f000-0000-7000-8000-000000000498';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();

function fakeDb(respond: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute(query: SQL) {
      const { sql, params } = dialect.sqlToQuery(query);
      calls.push({ sql, params });
      return Promise.resolve({ rows: respond(sql, params) });
    },
  };
  return { db: db as unknown as AthlyaDbAny, calls };
}

describe('export download links', () => {
  it('verifies a link it signed until it expires', async () => {
    const sig = await signExportDownload(SECRET, JOB_ID, 2_000);
    await expect(verifyExportDownload(SECRET, JOB_ID, 2_000, sig, 1_000)).resolves.toBe(true);
    await expect(verifyExportDownload(SECRET, JOB_ID, 2_000, sig, 2_000)).resolves.toBe(false);
  });

  it('rejects a link moved to another job, a stretched expiry or another key', async () => {
    const sig = await signExportDownload(SECRET, JOB_ID, 2_000);
    const other = '0193f000-0000-7000-8000-000000000499';
    await expect(verifyExportDownload(SECRET, other, 2_000, sig, 1_000)).resolves.toBe(false);
    await expect(verifyExportDownload(SECRET, JOB_ID, 3_000, sig, 1_000)).resolves.toBe(false);
    await expect(verifyExportDownload('x'.repeat(48), JOB_ID, 2_000, sig, 1_000)).resolves.toBe(
      false,
    );
  });

  it('rejects malformed signatures', async () => {
    await expect(verifyExportDownload(SECRET, JOB_ID, 2_000, '!!!', 1_000)).resolves.toBe(false);
    await expect(verifyExportDownload(SECRET, JOB_ID, 2_000, 'abc', 1_000)).resolves.toBe(false);
  });

  it('builds an absolute API URL carrying exp and sig', async () => {
    const url = new URL(
      await buildExportDownloadUrl('https://api.athlya.test', SECRET, JOB_ID, 2_000),
    );
    expect(url.origin).toBe('https://api.athlya.test');
    expect(url.pathname).toBe(`/v1/members/me/export/${JOB_ID}/download`);
    expect(url.searchParams.get('exp')).toBe('2000');
    await expect(
      verifyExportDownload(SECRET, JOB_ID, 2_000, url.searchParams.get('sig')!, 1_000),
    ).resolves.toBe(true);
  });
});

describe('buildBlobStore', () => {
  const bucket = { put: vi.fn(async () => undefined) } as unknown as R2Bucket;
  const key = `exports/members/${JOB_ID}.zip`;

  it('fails closed without the bucket', async () => {
    const blob = buildBlobStore(undefined, { ENVIRONMENT: 'staging' } as AthlyaBindings);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => blob.put(key, new Uint8Array())).toThrow(EXPORTS_BUCKET_MISSING_REASON);
  });

  it('fails closed without a signing key or public URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blob = buildBlobStore(bucket, {
      ENVIRONMENT: 'staging',
      EXPORT_URL_SIGNING_KEY: 'short',
      API_PUBLIC_URL: 'https://api.athlya.test',
    } as AthlyaBindings);
    await expect(blob.signedUrl(key, 60)).rejects.toThrow(EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON);
  });

  it('signs a download link for the archive job', async () => {
    const blob = buildBlobStore(bucket, {
      ENVIRONMENT: 'staging',
      EXPORT_URL_SIGNING_KEY: SECRET,
      API_PUBLIC_URL: 'https://api.athlya.test',
    } as AthlyaBindings);
    const url = new URL(await blob.signedUrl(key, 60));
    expect(url.pathname).toBe(`/v1/members/me/export/${JOB_ID}/download`);
  });
});

describe('createExportJobWorkerStore', () => {
  it('reports whether the claim was won', async () => {
    const won = fakeDb(() => [{ claimed: true }]);
    const lost = fakeDb(() => [{ claimed: false }]);
    await expect(createExportJobWorkerStore(won.db).markRunning(JOB_ID, new Date())).resolves.toBe(
      true,
    );
    await expect(createExportJobWorkerStore(lost.db).markRunning(JOB_ID, new Date())).resolves.toBe(
      false,
    );
    expect(won.calls[0]?.sql).toContain('export_job_claim(');
  });

  it('maps export_job_get rows', async () => {
    const { db } = fakeDb(() => [
      {
        id: JOB_ID,
        user_id: USER_ID,
        status: 'pending',
        requested_at: '2026-10-12T00:00:00Z',
        started_at: null,
        completed_at: null,
        error: null,
        download_url: null,
        download_expires_at: null,
      },
    ]);
    await expect(createExportJobWorkerStore(db).get(JOB_ID)).resolves.toMatchObject({
      id: JOB_ID,
      userId: USER_ID,
      status: 'pending',
      requestedAt: '2026-10-12T00:00:00.000Z',
    });
  });

  it('cannot enqueue', async () => {
    const { db } = fakeDb(() => []);
    await expect(
      createExportJobWorkerStore(db).create(JOB_ID, USER_ID, new Date()),
    ).rejects.toThrow();
  });
});

describe('createExportDataSource', () => {
  const profile = {
    id: USER_ID,
    studioId: 's',
    email: 'a@athlya.test',
    displayName: 'A',
    avatarUrl: null,
    role: 'member',
    createdAt: '2026-01-01T00:00:00.000Z',
    consents: { marketing: true },
  };

  it('returns profile and consents of the claimed job', async () => {
    const { db } = fakeDb(() => [{ profile }]);
    const source = createExportDataSource(db);
    const { consents: _c, ...expected } = profile;
    await expect(source.fetchProfile(USER_ID, JOB_ID)).resolves.toEqual(expected);
    await expect(source.fetchConsents(USER_ID, JOB_ID)).resolves.toEqual([{ marketing: true }]);
  });

  it('refuses when the job is not claimed or belongs to someone else', async () => {
    const unclaimed = createExportDataSource(fakeDb(() => [{ profile: null }]).db);
    const other = createExportDataSource(fakeDb(() => [{ profile: { ...profile, id: 'x' } }]).db);
    await expect(unclaimed.fetchProfile(USER_ID, JOB_ID)).rejects.toThrow(
      EXPORT_JOB_NOT_CLAIMED_REASON,
    );
    await expect(other.fetchProfile(USER_ID, JOB_ID)).rejects.toThrow(
      EXPORT_JOB_NOT_CLAIMED_REASON,
    );
  });

  it('pages a section with the keyset cursor until a short page', async () => {
    const pages = [
      [
        { cursor: 'c1', data: { id: 'r1' } },
        { cursor: 'c2', data: { id: 'r2' } },
      ],
      [{ cursor: 'c3', data: { id: 'r3' } }],
    ];
    const { db, calls } = fakeDb(() => pages.shift() ?? []);
    const seen: unknown[] = [];
    for await (const page of createExportDataSource(db, 2).listReservations(USER_ID, JOB_ID)) {
      seen.push(...page);
    }
    expect(seen).toEqual([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    expect(calls.map((c) => c.params)).toEqual([
      [JOB_ID, 'reservations', null, 2],
      [JOB_ID, 'reservations', 'c2', 2],
    ]);
  });

  it('exports no invoices until billing persistence exists', async () => {
    const { db, calls } = fakeDb(() => []);
    const pages: unknown[] = [];
    for await (const page of createExportDataSource(db).listInvoices(USER_ID, JOB_ID)) {
      pages.push(page);
    }
    expect(pages).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

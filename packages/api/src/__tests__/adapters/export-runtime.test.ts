import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createExportDataSource,
  EXPORT_JOB_NOT_CLAIMED_REASON,
  EXPORT_ROWS_MAX_PAGE_SIZE,
} from '../../adapters/export-data-source.js';
import {
  buildBlobStore,
  EXPORTS_BUCKET_MISSING_REASON,
  jobIdFromObjectKey,
} from '../../adapters/export-deps.js';
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
const CURRENT_CLAIM = '0193f000-0000-7000-8000-00000000c1a1';
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

  it.each(['A', 'AAAAA', 'A'.repeat(41)])(
    'rejects the undecodable base64url signature %s instead of throwing',
    async (sig) => {
      await expect(verifyExportDownload(SECRET, JOB_ID, 2_000, sig, 1_000)).resolves.toBe(false);
    },
  );

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
  const key = `exports/members/${JOB_ID}/${CURRENT_CLAIM}.zip`;

  it('fails closed without the bucket', async () => {
    const blob = buildBlobStore(undefined, { ENVIRONMENT: 'staging' } as AthlyaBindings);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => blob.put(key, new Uint8Array())).toThrow(EXPORTS_BUCKET_MISSING_REASON);
  });

  it('fails closed with a signing key that is too short', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blob = buildBlobStore(bucket, {
      ENVIRONMENT: 'staging',
      EXPORT_URL_SIGNING_KEY: 'short',
      API_PUBLIC_URL: 'https://api.athlya.test',
    } as AthlyaBindings);
    await expect(blob.signedUrl(key, 60)).rejects.toThrow(EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON);
  });

  it('fails closed without a public API URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blob = buildBlobStore(bucket, {
      ENVIRONMENT: 'staging',
      EXPORT_URL_SIGNING_KEY: SECRET,
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

  it('signs a link for an uppercase job id', async () => {
    const upperJobId = JOB_ID.toUpperCase();
    const blob = buildBlobStore(bucket, {
      ENVIRONMENT: 'staging',
      EXPORT_URL_SIGNING_KEY: SECRET,
      API_PUBLIC_URL: 'https://api.athlya.test',
    } as AthlyaBindings);
    const url = new URL(
      await blob.signedUrl(`exports/members/${upperJobId}/${CURRENT_CLAIM.toUpperCase()}.zip`, 60),
    );
    expect(url.pathname).toBe(`/v1/members/me/export/${upperJobId}/download`);
  });

  it('deletes one archive', async () => {
    const del = vi.fn(async () => undefined);
    const blob = buildBlobStore(
      { delete: del } as unknown as R2Bucket,
      {
        ENVIRONMENT: 'staging',
      } as AthlyaBindings,
    );
    await blob.delete(key);
    expect(del).toHaveBeenCalledWith(key);
  });

  it('deletes every archive of the job except the published one, across pages', async () => {
    const published = key;
    const staleA = `exports/members/${JOB_ID}/0193f000-0000-7000-8000-0000000000aa.zip`;
    const staleB = `exports/members/${JOB_ID}/0193f000-0000-7000-8000-0000000000bb.zip`;
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: staleA }, { key: published }],
        truncated: true,
        cursor: 'page-2',
      })
      .mockResolvedValueOnce({ objects: [{ key: staleB }], truncated: false });
    const del = vi.fn(async () => undefined);
    const blob = buildBlobStore(
      { list, delete: del } as unknown as R2Bucket,
      {
        ENVIRONMENT: 'staging',
      } as AthlyaBindings,
    );

    await blob.deleteJobArchivesExcept(JOB_ID, published);

    expect(list).toHaveBeenNthCalledWith(1, { prefix: `exports/members/${JOB_ID}/`, limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: `exports/members/${JOB_ID}/`,
      limit: 100,
      cursor: 'page-2',
    });
    expect(del.mock.calls).toEqual([[[staleA]], [[staleB]]]);
  });

  it('skips the delete call when only the published archive exists', async () => {
    const list = vi.fn().mockResolvedValueOnce({ objects: [{ key }], truncated: false });
    const del = vi.fn(async () => undefined);
    const blob = buildBlobStore(
      { list, delete: del } as unknown as R2Bucket,
      {
        ENVIRONMENT: 'staging',
      } as AthlyaBindings,
    );
    await blob.deleteJobArchivesExcept(JOB_ID, key);
    expect(del).not.toHaveBeenCalled();
  });

  it('has nothing to delete without the bucket', async () => {
    const blob = buildBlobStore(undefined, { ENVIRONMENT: 'staging' } as AthlyaBindings);
    await expect(blob.delete(key)).resolves.toBeUndefined();
    await expect(blob.deleteJobArchivesExcept(JOB_ID, key)).resolves.toBeUndefined();
  });
});

describe('jobIdFromObjectKey', () => {
  it('parses lowercase and uppercase UUID keys', () => {
    expect(jobIdFromObjectKey(`exports/members/${JOB_ID}/${CURRENT_CLAIM}.zip`)).toBe(JOB_ID);
    const upper = `exports/members/${JOB_ID.toUpperCase()}/${CURRENT_CLAIM.toUpperCase()}.zip`;
    expect(jobIdFromObjectKey(upper)).toBe(JOB_ID.toUpperCase());
  });

  it('rejects keys outside the per-claim layout', () => {
    expect(() => jobIdFromObjectKey(`exports/members/${JOB_ID}.zip`)).toThrow(
      'unexpected export object key',
    );
    expect(() => jobIdFromObjectKey(`avatars/${JOB_ID}/${CURRENT_CLAIM}.zip`)).toThrow(
      'unexpected export object key',
    );
  });
});

describe('createExportJobWorkerStore', () => {
  it('returns the claim token only when the claim was won', async () => {
    const won = fakeDb(() => [{ claim_token: CURRENT_CLAIM }]);
    const lost = fakeDb(() => [{ claim_token: null }]);
    await expect(createExportJobWorkerStore(won.db).markRunning(JOB_ID, new Date())).resolves.toBe(
      CURRENT_CLAIM,
    );
    await expect(
      createExportJobWorkerStore(lost.db).markRunning(JOB_ID, new Date()),
    ).resolves.toBeNull();
    expect(won.calls[0]?.sql).toContain('export_job_claim(');
  });

  it('passes the claim token to completion and failure', async () => {
    const current = fakeDb(() => [{ completed: true }]);
    const stale = fakeDb(() => [{ completed: false }]);
    const expires = new Date('2026-10-15T00:00:00.000Z');
    await expect(
      createExportJobWorkerStore(current.db).markCompleted(
        JOB_ID,
        CURRENT_CLAIM,
        new Date(),
        'https://api.athlya.test/dl',
        expires,
      ),
    ).resolves.toBe(true);
    await expect(
      createExportJobWorkerStore(stale.db).markCompleted(
        JOB_ID,
        CURRENT_CLAIM,
        new Date(),
        'https://api.athlya.test/dl',
        expires,
      ),
    ).resolves.toBe(false);
    expect(current.calls[0]?.sql).toContain('export_job_complete(');
    expect(current.calls[0]?.params.slice(0, 2)).toEqual([JOB_ID, CURRENT_CLAIM]);

    const failed = fakeDb(() => [{ export_job_fail: false }]);
    await createExportJobWorkerStore(failed.db).markFailed(JOB_ID, CURRENT_CLAIM, 'boom');
    expect(failed.calls[0]?.sql).toContain('export_job_fail(');
    expect(failed.calls[0]?.params).toEqual([JOB_ID, CURRENT_CLAIM, 'boom']);
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

  it('clamps the page size to the SQL cap so full pages keep paging', async () => {
    const fullPage = (from: number) =>
      Array.from({ length: EXPORT_ROWS_MAX_PAGE_SIZE }, (_, i) => ({
        cursor: `c${from + i}`,
        data: { id: `r${from + i}` },
      }));
    const pages = [fullPage(0), [{ cursor: 'last', data: { id: 'last' } }]];
    const { db, calls } = fakeDb(() => pages.shift() ?? []);
    let seen = 0;
    for await (const page of createExportDataSource(db, 1_000).listReservations(USER_ID, JOB_ID)) {
      seen += page.length;
    }
    expect(seen).toBe(EXPORT_ROWS_MAX_PAGE_SIZE + 1);
    expect(calls.map((c) => c.params[3])).toEqual([
      EXPORT_ROWS_MAX_PAGE_SIZE,
      EXPORT_ROWS_MAX_PAGE_SIZE,
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

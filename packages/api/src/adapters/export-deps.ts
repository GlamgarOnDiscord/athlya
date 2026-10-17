/**
 * Compose the {@link RunExportJobDeps} bundle consumed by
 * {@link import('@athlya/members').runExportJob} for the
 * `members.export.requested` queue consumer.
 *
 * The consumer runs as `athlya_app` with no tenant claims (issue #498):
 *
 *   - `jobs`    — {@link createExportJobWorkerStore}: atomic claim with a
 *                 lease and guarded transitions through the SECURITY
 *                 DEFINER functions of migration 0034.
 *   - `data`    — {@link createExportDataSource}: personal data readable
 *                 only for the claimed job, paged by keyset cursor.
 *   - `archive` — fflate ZIP builder.
 *   - `blob`    — R2 `EXPORTS_BUCKET` upload + signed API download link
 *                 (`export-download.ts`). Fails closed with a stable
 *                 reason when the bucket, `EXPORT_URL_SIGNING_KEY` or
 *                 `API_PUBLIC_URL` is not configured, so a job is marked
 *                 `failed` rather than completed with an unusable URL.
 *   - `events`  — best-effort Cloudflare Queues publisher for
 *                 `members.export.completed`.
 *
 * @see Requirements 4.1, 4.2, 4.4 ; audit finding S5-001.
 */

import { exportJobPrefix } from '@athlya/members';

import { buildRoutedPublishDeps } from '../events/publish-deps.js';
import { publish } from '../events/publish.js';

import { getOrCreateDbHttp } from './deps-cache.js';
import { createExportDataSource } from './export-data-source.js';
import {
  EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON,
  buildExportDownloadUrl,
} from './export-download.js';
import { createFflateArchiveBuilder } from './fflate-archive.js';
import { createExportJobWorkerStore } from './members-export-job-store-drizzle.js';

import type { AthlyaBindings } from '../types.js';
import type { BlobStore, EventPublisher, RunExportJobDeps } from '@athlya/members';
import type { AthlyaEvent } from '@athlya/shared/events';
import type { R2Bucket } from '@cloudflare/workers-types';

/* ------------------------------------------------------------------ */
/*  Stable error reasons                                               */
/* ------------------------------------------------------------------ */

/**
 * Reason stamped on `export_jobs.error` when the R2 bucket binding
 * is missing. Stable, machine-greppable string so on-call can
 * filter the failure mode in Tail Workers / Logpush.
 */
export const EXPORTS_BUCKET_MISSING_REASON = 'exports_bucket_missing';

/* ------------------------------------------------------------------ */
/*  R2 BlobStore                                                       */
/* ------------------------------------------------------------------ */

/** Page size for listing the archives of one job (R2 caps it at 1000). */
const ARCHIVE_LIST_LIMIT = 100;

/**
 * Object key layout from `exportObjectKey`: `exports/members/{jobId}/{claimToken}.zip`.
 * UUIDs are matched case-insensitively, like the export job id contract.
 */
export function jobIdFromObjectKey(key: string): string {
  const match = /^exports\/members\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.zip$/iu.exec(key);
  if (match?.[1] === undefined) {
    throw new Error(`unexpected export object key: ${key}`);
  }
  return match[1];
}

/**
 * Build an R2-backed {@link BlobStore} (or a fail-closed shim when the
 * bucket binding is absent). `signedUrl` returns an API download link
 * signed with `EXPORT_URL_SIGNING_KEY` (see `export-download.ts`).
 */
export function buildBlobStore(bucket: R2Bucket | undefined, env: AthlyaBindings): BlobStore {
  if (bucket === undefined) {
    const refuse = (objectKey: string): never => {
      console.warn('[export-deps] EXPORTS_BUCKET binding missing — export refused', {
        objectKey,
        env: env.ENVIRONMENT,
        reason: EXPORTS_BUCKET_MISSING_REASON,
      });
      throw new Error(EXPORTS_BUCKET_MISSING_REASON);
    };
    return {
      put: (key) => refuse(key),
      signedUrl: (key) => refuse(key),
      // Nothing can have been uploaded without the bucket.
      delete: () => Promise.resolve(),
      deleteJobArchivesExcept: () => Promise.resolve(),
    };
  }

  return {
    async put(key, bytes) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: 'application/zip' },
      });
    },
    async signedUrl(key, expiresSec) {
      const secret = env.EXPORT_URL_SIGNING_KEY ?? '';
      const baseUrl = env.API_PUBLIC_URL ?? '';
      if (secret.length < 32 || baseUrl === '') {
        console.error('[export-deps] export download signing not configured', {
          env: env.ENVIRONMENT,
          reason: EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON,
        });
        throw new Error(EXPORT_DOWNLOAD_NOT_CONFIGURED_REASON);
      }
      const exp = Math.floor(Date.now() / 1000) + expiresSec;
      return buildExportDownloadUrl(baseUrl, secret, jobIdFromObjectKey(key), exp);
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async deleteJobArchivesExcept(jobId, keepKey) {
      const prefix = exportJobPrefix(jobId);
      let cursor: string | undefined;
      do {
        const listing = await bucket.list({
          prefix,
          limit: ARCHIVE_LIST_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const stale = listing.objects.map((o) => o.key).filter((k) => k !== keepKey);
        if (stale.length > 0) await bucket.delete(stale);
        cursor = listing.truncated ? listing.cursor : undefined;
      } while (cursor !== undefined);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Event publisher                                                    */
/* ------------------------------------------------------------------ */

/**
 * Wrap the Cloudflare Queues binding in the {@link EventPublisher}
 * port the export consumer uses to emit `members.export.completed`.
 * Pattern mirrors `members-deps.ts`'s `buildEventPublisher`:
 * best-effort with a structured warn log on failure.
 */
function buildEventPublisher(env: AthlyaBindings): EventPublisher {
  return {
    async publish(event: AthlyaEvent) {
      try {
        await publish(event, undefined, buildRoutedPublishDeps(env));
      } catch (err) {
        console.warn('[export-deps] publishEvent failed', {
          eventId: event.id,
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  buildExportDeps                                                    */
/* ------------------------------------------------------------------ */

/**
 * Produce the {@link RunExportJobDeps} bundle for a live
 * `AthlyaBindings` env.
 *
 * Pure function — no I/O at construction time. The Drizzle handle
 * is read from the per-isolate cache (`deps-cache.ts`); R2 binding
 * is captured by reference; every adapter is built fresh per call
 * (cheap — no long-lived state).
 *
 * The returned bundle is consumed by the Worker's `queue()`
 * dispatcher in `worker.ts` once per `members.export.requested`
 * event.
 */
export function buildExportDeps(env: AthlyaBindings): RunExportJobDeps {
  const db = getOrCreateDbHttp(env.DB_URL);
  const jobs = createExportJobWorkerStore(db);
  const blob = buildBlobStore(env.EXPORTS_BUCKET, env);
  const data = createExportDataSource(db);
  const archive = createFflateArchiveBuilder();
  const events = buildEventPublisher(env);

  return {
    jobs,
    data,
    archive,
    blob,
    events,
    clock: { now: () => Date.now() },
    uuid: () => crypto.randomUUID(),
    logger: {
      warn: (msg, extra) => {
        console.warn(`[export] ${msg}`, extra ?? {});
      },
      error: (msg, extra) => {
        console.error(`[export] ${msg}`, extra ?? {});
      },
    },
  };
}

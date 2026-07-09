/**
 * Compose the {@link RunExportJobDeps} bundle consumed by
 * {@link import('@athlya/members').runExportJob}.
 *
 * Wires the Worker bindings the RGPD export consumer needs into the
 * abstract ports declared by the export module:
 *
 *   - `jobs`      — Drizzle-backed `ExportJobStore` (already shipped
 *                   by `members-export-job-store-drizzle.ts`).
 *   - `data`      — `MemberDataSource` stub. **Not wired in this
 *                   slice** — the full Drizzle/Stripe DataSource
 *                   adapter ships in a follow-up slice (cf. audit
 *                   finding S5-001 mitigation §1, "MemberDataSource
 *                   → Drizzle"). Until then, every method throws a
 *                   well-known error so {@link runExportJob}'s
 *                   try/catch around the data-collection phase
 *                   markFailed's the job with a clear reason
 *                   (`export_data_source_not_wired`) instead of
 *                   silently completing an empty archive.
 *   - `archive`   — `ArchiveBuilder` stub. Never reached on the
 *                   degraded path because `data` throws first; kept
 *                   on the bundle so the type matches the port and
 *                   the next slice can drop in a real `fflate` impl
 *                   without changing the wiring.
 *   - `blob`      — R2-backed `BlobStore` (mode dégradé when
 *                   `EXPORTS_BUCKET` is unbound — see below).
 *   - `events`    — Reuses the same Cloudflare-Queues-backed
 *                   publisher pattern as `members-deps.ts`.
 *   - `clock`     — `Date.now()`.
 *   - `uuid`      — `crypto.randomUUID()`.
 *   - `logger`    — falls back to a `console`-backed shim because
 *                   queue consumers run outside the Hono request
 *                   context (no `c.get('logger')`).
 *
 * Slice 1.3 — Sprint 1 — resolves audit finding S5-001 (CRITICAL
 * RGPD Article 15/20 export not wired). Pure plumbing: the
 * dispatch path lights up so `members.export.requested` events
 * stop accumulating in the DLQ. The full happy-path archive build
 * (DataSource + ArchiveBuilder) is intentionally deferred — the
 * surfaced `failed` jobs replace the previous "stuck pending
 * forever" state, which is a strict observability win even before
 * the archive completes end-to-end.
 *
 * Mode dégradé R2 (binding absent)
 * ---------------------------------
 * When `EXPORTS_BUCKET` is `undefined` (the bucket has not been
 * provisioned yet via `wrangler r2 bucket create
 * athlya-exports-{env}` — cf. Vague 26 runbook), the BlobStore
 * adapter throws on first `put`. {@link runExportJob} catches that
 * throw inside its archive/upload phase and marks the job
 * `failed` with a stable reason (`exports_bucket_missing`).
 * Pattern matches the B9 Stripe degraded mode (`billing-deps.ts`)
 * and the cascade S5-002 wiring (`cascade-deps.ts`).
 *
 * @see Requirements 4.1, 4.2, 4.4 ; audit finding S5-001.
 */

import { buildRoutedPublishDeps } from '../events/publish-deps.js';
import { publish } from '../events/publish.js';

import { getOrCreateDbHttp } from './deps-cache.js';
import { createFflateArchiveBuilder } from './fflate-archive.js';
import { createDrizzleExportJobStore } from './members-export-job-store-drizzle.js';

import type { AthlyaBindings } from '../types.js';
import type {
  BlobStore,
  EventPublisher,
  MemberDataSource,
  RunExportJobDeps,
} from '@athlya/members';
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

/**
 * Reason stamped on `export_jobs.error` when the consumer reaches
 * the data-collection phase before the full DataSource adapter
 * ships. Replaces the previous "stuck in pending forever" state
 * with a clean failure surface (cf. audit S5-001 mitigation §1).
 */
export const EXPORT_DATA_SOURCE_NOT_WIRED_REASON = 'export_data_source_not_wired';

/* ------------------------------------------------------------------ */
/*  R2 BlobStore                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build an R2-backed {@link BlobStore} (or a degraded-mode shim
 * when the bucket binding is absent).
 *
 * Production happy path: `put(key, bytes)` issues a single R2
 * `put`; `signedUrl` returns the bucket's public URL since
 * Cloudflare R2 signed URLs require an external signer (S3-style
 * presign or Worker-side signing) which lands in the next slice.
 * For now, a clearly-typed `Error` makes the partial state
 * observable on the audit side.
 */
function buildBlobStore(bucket: R2Bucket | undefined, env: AthlyaBindings): BlobStore {
  if (bucket === undefined) {
    return {
      put(key) {
        console.warn(
          '[export-deps] EXPORTS_BUCKET binding missing — refusing to upload archive (mode dégradé)',
          {
            objectKey: key,
            env: env.ENVIRONMENT,
            reason: EXPORTS_BUCKET_MISSING_REASON,
          },
        );
        throw new Error(EXPORTS_BUCKET_MISSING_REASON);
      },
      signedUrl(key) {
        console.warn(
          '[export-deps] EXPORTS_BUCKET binding missing — refusing to sign URL (mode dégradé)',
          {
            objectKey: key,
            env: env.ENVIRONMENT,
            reason: EXPORTS_BUCKET_MISSING_REASON,
          },
        );
        throw new Error(EXPORTS_BUCKET_MISSING_REASON);
      },
    };
  }

  return {
    async put(key, bytes) {
      await bucket.put(key, bytes);
    },
    signedUrl(_key, _expiresSec) {
      // R2 signed-URL issuance lives outside the binding API
      // (S3-style HMAC presign) and ships in the follow-up
      // slice. Throwing keeps `runExportJob` honest: it will
      // markFailed with this reason instead of stamping a
      // bogus URL on a `completed` row.
      throw new Error(EXPORT_DATA_SOURCE_NOT_WIRED_REASON);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Stub MemberDataSource                                              */
/* ------------------------------------------------------------------ */

function throwingIterable<T>(reason: string): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.reject(new Error(reason));
        },
      };
    },
  };
}

/**
 * Build a {@link MemberDataSource} that throws on every method.
 *
 * This is the deferred-work seam: until the full Drizzle/Stripe
 * adapter ships, the consumer cannot legitimately produce a
 * complete archive (Req 4.4 enumerates six required collections,
 * three of which lack a wired repo today: `checkins`, `invoices`,
 * `auditTrail`). Throwing on the first method call lets
 * {@link runExportJob} catch the error inside its own try/catch,
 * markFailed the job with a stable reason and skip the
 * `members.export.completed` event publish. The user-facing
 * surface (the eventual `GET /v1/members/me/export/:jobId`
 * endpoint) returns `failed` with that reason — strictly better
 * than the previous "stuck pending forever" observable that the
 * audit flagged as the CRITICAL S5-001.
 */
function buildStubDataSource(): MemberDataSource {
  const reason = EXPORT_DATA_SOURCE_NOT_WIRED_REASON;
  return {
    fetchProfile() {
      throw new Error(reason);
    },
    fetchConsents() {
      throw new Error(reason);
    },
    listReservations() {
      return throwingIterable(reason);
    },
    listSessions() {
      return throwingIterable(reason);
    },
    listCheckins() {
      return throwingIterable(reason);
    },
    listInvoices() {
      return throwingIterable(reason);
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
  const jobs = createDrizzleExportJobStore(db);
  const blob = buildBlobStore(env.EXPORTS_BUCKET, env);
  const data = buildStubDataSource();
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

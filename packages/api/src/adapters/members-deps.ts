/**
 * Compose the router-level `MembersDeps` bundle from a live
 * `AthlyaBindings` env.
 *
 * Wires the four Drizzle-backed adapters shipped in this folder:
 *
 *   - `createDrizzleMemberRepo`       — `MemberRepo`
 *     (`getProfile`, `updateProfile`, `listByStudio`).
 *   - `createDrizzleConsentsRepo`     — `ConsentsRepo`
 *     (`findConsents`, `updateConsents`).
 *   - `createDrizzleAuditLogWriter`   — `AuditLogWriter.append`.
 *   - `createDrizzleExportJobStore`   — `ExportJobStore.*`
 *
 * Plus the event publisher — events go through the Cloudflare Queues
 * `EVENTS_QUEUE` binding via `publish` from
 * `@athlya/api/events/publish`. Same best-effort posture as the
 * `auth` wiring: a publish failure is logged but does NOT break the
 * user-facing write path.
 *
 * Cloudflare Workers caching strategy (Vague 18 — slice B1)
 * ---------------------------------------------------------
 * The Drizzle handle now uses `@neondatabase/serverless`'s HTTP
 * driver (`createDbHttp`) and is cached at module scope. None of
 * the members service flows open an interactive
 * `db.transaction(async tx => …)`, so the HTTP flavour is a strict
 * upgrade — see `auth-deps.ts` for the full rationale.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 4.1.
 */

import {
  getProfile as svcGetProfile,
  listMembersByStudio as svcListMembersByStudio,
  updateConsents as svcUpdateConsents,
  updateProfile as svcUpdateProfile,
  enqueueExport as svcEnqueueExport,
  type EnqueueExportResult,
  type MemberProfile,
  type MembersPage,
  type Role,
} from '@athlya/members';

import { publish, type Queue } from '../events/publish.js';

import {
  getOrCreateDbHttp,
  primeDbHttpForTests,
  resetAllDepsCachesForTests,
} from './deps-cache.js';
import { createDrizzleAuditLogWriter } from './members-audit-writer-drizzle.js';
import { createDrizzleConsentsRepo } from './members-consents-repo-drizzle.js';
import { createDrizzleExportJobStore } from './members-export-job-store-drizzle.js';
import { createDrizzleMemberRepo } from './members-repo-drizzle.js';

import type { MembersDeps } from '../routes/members.js';
import type { AthlyaBindings } from '../types.js';
import type { AthlyaDbHttp } from '@athlya/db/client';
import type { AthlyaEvent } from '@athlya/shared/events';
import type { UpdateConsentsRequest, UpdateProfileRequest } from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Per-isolate cache for the HTTP-driver Drizzle handle               */
/* ------------------------------------------------------------------ */

/**
 * Test seam — drop every cached handle so a unit test can swap the
 * connection string between calls without seeing the previous one's
 * cached client. Production code paths never call this.
 *
 * Slice B8.2 — the DB cache is now shared across auth/members/
 * reservations via `deps-cache.ts`. This shim flushes the shared
 * caches; members has no domain-specific cache to clear.
 */
export function __resetMembersDepsCachesForTests(): void {
  resetAllDepsCachesForTests();
}

/**
 * @internal Test seam — primes the per-isolate `dbHttpCache` for
 * `url` and reports the resulting cache size. Used by the B1.5
 * integration test to verify that 100 parallel calls share ONE DB
 * handle. Production code paths never call this.
 *
 * Slice B8.2 — delegates to the shared `primeDbHttpForTests` from
 * `deps-cache.ts`. Re-exported here so the B1.5 test's named imports
 * (`primeMembersDb`) keep working.
 */
export function __primeDbHttpForTests(url: string): {
  readonly size: number;
  readonly handle: AthlyaDbHttp;
} {
  return primeDbHttpForTests(url);
}

/* ------------------------------------------------------------------ */
/*  Event publisher wrapper                                            */
/* ------------------------------------------------------------------ */

/**
 * Wrap the Cloudflare Queues binding in the `EventPublisher` port the
 * export service consumes. Best-effort: a publish failure is logged
 * and swallowed — the job row is already persisted so the consumer
 * will pick it up once the queue is back.
 */
function buildEventPublisher(env: AthlyaBindings): {
  publish: (event: AthlyaEvent) => Promise<void>;
} {
  return {
    async publish(event) {
      try {
        await publish(event, undefined, {
          // FIXME(B8.3): Queue type not exposed by Cloudflare types — investigate
          queue: env.EVENTS_QUEUE as unknown as Queue,
        });
      } catch (err) {
        console.warn('[members-deps] publishEvent failed', {
          eventId: event.id,
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Router-level `MembersDeps`                                         */
/* ------------------------------------------------------------------ */

/**
 * Produce the `MembersDeps` bundle consumed by `buildMembersRouter`.
 *
 * Every method pulls the shared HTTP Drizzle handle from the
 * per-isolate cache and builds the lightweight adapter wrappers
 * fresh per call.
 */
export function buildMembersDeps(env: AthlyaBindings): MembersDeps {
  const now = () => Date.now();
  const events = buildEventPublisher(env);

  return {
    async getProfile(userId): Promise<MemberProfile> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo = createDrizzleMemberRepo(db);
      return svcGetProfile(userId, { repo });
    },

    async updateProfile(userId: string, patch: UpdateProfileRequest): Promise<MemberProfile> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo = createDrizzleMemberRepo(db);
      return svcUpdateProfile(userId, patch, { repo });
    },

    async updateConsents(userId: string, input: UpdateConsentsRequest) {
      const db = getOrCreateDbHttp(env.DB_URL);
      const consentsRepo = createDrizzleConsentsRepo(db);
      const audit = createDrizzleAuditLogWriter(db);
      return svcUpdateConsents(userId, input, {
        consentsRepo,
        audit,
        now,
      });
    },

    async enqueueExport(userId: string): Promise<{ jobId: string }> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const jobs = createDrizzleExportJobStore(db);
      const result: EnqueueExportResult = await svcEnqueueExport(userId, {
        jobs,
        events,
        clock: { now },
        uuid: () => crypto.randomUUID(),
      });
      // Both `ok` and `deduped` surface the same `jobId` to the
      // caller — the HTTP layer does not differentiate (both
      // map to 202). The `kind` is logged by the gateway's
      // request log for observability.
      return { jobId: result.jobId };
    },

    async listMembersByStudio(
      studioId: string,
      requesterRole: 'admin' | 'coach',
      opts,
    ): Promise<MembersPage> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo = createDrizzleMemberRepo(db);
      const role: Role = requesterRole;
      // Project the route-level `ListMembersQuery` shape onto
      // the service-level `ListMembersOptions` shape so the
      // `exactOptionalPropertyTypes` boundary stays tight (no
      // explicit `undefined` leaking onto an optional field).
      const repoOpts: { cursor?: string; limit?: number } = {};
      if (opts.cursor !== undefined) repoOpts.cursor = opts.cursor;
      if (opts.limit !== undefined) repoOpts.limit = opts.limit;
      return svcListMembersByStudio(studioId, role, repoOpts, { repo });
    },
  };
}

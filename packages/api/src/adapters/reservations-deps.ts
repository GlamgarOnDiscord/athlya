/**
 * Compose the router-level `ClassesDeps` and `ReservationsDeps`
 * bundles from a live `AthlyaBindings` env.
 *
 * Wires the Drizzle-backed class repos + the Upstash Redis
 * remaining-seats counter from `@athlya/reservations` into the
 * service-layer use cases:
 *
 *   - `listClasses`          — `GET /v1/classes` (Req 7.1, 7.2, 7.3).
 *   - `createClass`          — `POST /v1/classes` admin (Req 6.1-6.4).
 *   - `updateClass`          — `PATCH /v1/classes/:id` admin (Req 6.5-6.7).
 *   - `listMyReservations`   — `GET /v1/reservations/me` (Req 7.4).
 *   - `bookClass`            — `POST /v1/reservations` (Algorithm 1).
 *   - `cancelReservation`    — `DELETE /v1/reservations/:id` (Algorithm 2).
 *
 * Cloudflare Workers caching strategy (Vague 18 — slice B1)
 * ---------------------------------------------------------
 * The wiring is **hybrid** because the two write algorithms (book +
 * cancel) require interactive transactions with TS-side branching
 * between statements, which only the postgres-js flavour supports:
 *
 *   • Read paths (`listClasses`, `listMyReservations`,
 *     `findClass` on the booking pre-flight, …) and simple
 *     `INSERT … RETURNING` / `UPDATE … WHERE` writes
 *     (`createClass`, `updateClass`) use the HTTP-driver
 *     {@link AthlyaDbHttp}. That handle is stateless and cached at
 *     module scope across requests inside one isolate.
 *
 *   • Write paths that open `db.transaction(async tx => …)` with
 *     `SELECT FOR UPDATE` + conditional logic — i.e. `bookClass`
 *     and `cancelReservation` — keep using the postgres-js
 *     {@link AthlyaDb} via {@link createDb}. That client holds a
 *     TCP socket and therefore CANNOT be cached across requests in
 *     a Cloudflare Worker (the runtime would raise "Cannot perform
 *     I/O on behalf of a different request"); we rebuild it per
 *     call. The extra TLS handshake is the unavoidable cost of
 *     interactive transactional semantics on this runtime.
 *
 * `withTenant(claims, fn)` is intentionally NOT wired here yet
 * because the HTTP driver does not support the interactive
 * `db.transaction(async tx => …)` form `withTenant` requires
 * (see `packages/db/src/client.ts`). Tenant scope is instead
 * enforced **at the query layer** by every adapter:
 *
 *   • Class reads filter on `classes.studio_id = claims.studioId`
 *     (`createDrizzleListClassesRepo`, `createDrizzleUpdateClassRepo`).
 *   • Reservation reads filter on `reservations.user_id =
 *     claims.userId` (`listMyReservations`,
 *     `cancelReservation` via `findReservationForUpdate`).
 *
 * The RLS policies on these tables (installed by `0001_rls.sql`,
 * FORCEd on `athlya_app` by `0004_rls_hardening.sql`) are the
 * defense-in-depth backstop: a missing `WHERE` clause would still
 * be blocked at the database level once `DB_URL` points to
 * `athlya_app` (Req H1, runbook
 * `docs/runbooks/db-role-switch.md`).
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2,
 *      7.3, 7.4, 8.1–8.6, 9.1–9.5, 10.1–10.5.
 */

import { createDb, type AthlyaDb, type AthlyaDbHttp } from '@athlya/db/client';
import {
  listClasses as svcListClasses,
  createClass as svcCreateClass,
  bookClass as svcBookClass,
  createRedisRemainingCounter,
} from '@athlya/reservations';
import { cancelReservation as svcCancelReservation } from '@athlya/reservations/cancel';
import { updateClass as svcUpdateClass } from '@athlya/reservations/update';

import {
  createDrizzleCreateClassRepo,
  createDrizzleDeleteClassRepo,
  createDrizzleListClassesRepo,
  createDrizzleUpdateClassRepo,
} from './classes-repo-drizzle.js';
import {
  getOrCreateDbHttp,
  getOrCreateRedis,
  primeDbHttpForTests,
  resetAllDepsCachesForTests,
} from './deps-cache.js';
import { listMyReservations as queryListMyReservations } from './reservations-list-drizzle.js';
import {
  createBookingEventPublisher,
  createDrizzleBookingRepo,
  createDrizzleCancelRepo,
} from './reservations-write-drizzle.js';

import type { ClassesDeps, DeleteClassOutcome, UpdateClassOutcome } from '../routes/classes.js';
import type { ReservationsDeps } from '../routes/reservations.js';
import type { AthlyaBindings } from '../types.js';
import type { ClassRow } from '@athlya/db/schema';
import type { ClassListing } from '@athlya/reservations';
import type { StudioId } from '@athlya/shared/ids';
import type {
  CreateClassRequest,
  ListClassesQuery,
  UpdateClassRequest,
} from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Per-isolate caches (HTTP DB + Redis) — shared via deps-cache       */
/* ------------------------------------------------------------------ */

/**
 * Per-request postgres-js Drizzle factory — used **only** by the
 * book / cancel paths that need an interactive transaction. Caching
 * this client across requests would trigger Cloudflare Workers'
 * "Cannot perform I/O on behalf of a different request" because the
 * `postgres` driver holds a TCP socket scoped to the request that
 * created it.
 *
 *   - `maxConnections: 1` — Workers are single-threaded per isolate;
 *     a larger pool would reserve Neon connections we cannot use
 *     concurrently and amplify the suspended-compute failure mode.
 *   - `idleTimeoutSec: 5` — release the socket as soon as the
 *     transaction commits so memory stays flat across back-to-back
 *     calls inside one isolate.
 */
function makeWriteDb(connectionString: string): AthlyaDb {
  return createDb(connectionString, {
    maxConnections: 1,
    idleTimeoutSec: 5,
  });
}

/**
 * Test seam — drop every cached handle. Production code paths never
 * call this.
 *
 * Slice B8.2 — the DB + Redis caches are now shared across
 * auth/members/reservations via `deps-cache.ts`. This shim flushes
 * the shared caches; reservations has no domain-specific cache to
 * clear.
 */
export function __resetReservationsDepsCachesForTests(): void {
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
 * (`primeReservationsDb`) keep working.
 */
export function __primeDbHttpForTests(url: string): {
  readonly size: number;
  readonly handle: AthlyaDbHttp;
} {
  return primeDbHttpForTests(url);
}

/* ------------------------------------------------------------------ */
/*  Classes deps                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the `ClassesDeps` bundle. Every method composes the shared
 * HTTP DB + Redis handles from the per-isolate caches and a fresh
 * thin adapter wrapper.
 */
export function buildClassesDeps(env: AthlyaBindings): ClassesDeps {
  return {
    async listClasses(
      studioId: string,
      range: ListClassesQuery,
    ): Promise<{ items: ClassListing[] }> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
      const classRepo = createDrizzleListClassesRepo(db);
      const counter = createRedisRemainingCounter(redis);
      const items = await svcListClasses(studioId, range, {
        classRepo,
        counter,
      });
      return { items };
    },

    async createClass(studioId: string, input: CreateClassRequest): Promise<ClassRow> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
      const classRepo = createDrizzleCreateClassRepo(db);
      const counter = createRedisRemainingCounter(redis);
      return svcCreateClass(studioId as StudioId, input, {
        classRepo,
        counter,
      });
    },

    async deleteClass(studioId: string, classId: string): Promise<DeleteClassOutcome> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo = createDrizzleDeleteClassRepo(db);
      const found = await repo.deleteClass(studioId, classId);
      return found ? { kind: 'deleted' } : { kind: 'not_found' };
    },

    async updateClass(
      _studioId: string,
      classId: string,
      patch: UpdateClassRequest,
    ): Promise<UpdateClassOutcome> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
      const classRepo = createDrizzleUpdateClassRepo(db);
      const counter = createRedisRemainingCounter(redis);

      try {
        const row = await svcUpdateClass(classId, patch, 'admin', {
          classRepo,
          counter,
        });
        return { kind: 'updated', class: row };
      } catch (err) {
        // Translate the typed `UpdateClassError` into the
        // discriminated outcome the router expects.
        // Duck-typed to avoid pulling the runtime class in.
        const code = extractUpdateErrorCode(err);
        if (code === 'not_found') return { kind: 'not_found' };
        if (code === 'conflict') return { kind: 'conflict' };
        throw err;
      }
    },
  };
}

/**
 * Narrow an unknown thrown value to the `UpdateClassError` shape
 * (`.name === 'UpdateClassError'` + `.code` in a known set). Duck
 * typing keeps the API layer free of a runtime dep on
 * `@athlya/reservations/update`'s class object.
 */
function extractUpdateErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const probe = err as { name?: unknown; code?: unknown };
  if (probe.name !== 'UpdateClassError') return null;
  return typeof probe.code === 'string' ? probe.code : null;
}

/* ------------------------------------------------------------------ */
/*  Reservations deps                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the `ReservationsDeps` bundle.
 *
 * Read path:
 *   - `listMyReservations` → cached HTTP Drizzle handle.
 *
 * Write paths (interactive transactions, postgres-js per request):
 *   - `bookClass`         → Algorithm 1 (two-phase Redis DECR + SQL
 *                           insert with `UNIQUE(class_id, user_id)`
 *                           as the ultimate guard). The
 *                           `findClass` pre-flight runs against the
 *                           cached HTTP handle — it's a single read
 *                           and does not need the transaction.
 *   - `cancelReservation` → Algorithm 2 (`SELECT FOR UPDATE` on the
 *                           reservation + class rows, FIFO `SKIP
 *                           LOCKED` waitlist promotion).
 */
export function buildReservationsDeps(env: AthlyaBindings): ReservationsDeps {
  return {
    async listMyReservations(userId: string, query) {
      const db = getOrCreateDbHttp(env.DB_URL);
      return queryListMyReservations(userId, query, { db });
    },

    async bookClass(userId, input) {
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);

      // Per-request postgres-js client — `bookClass` opens an
      // interactive `withTransaction(async tx => …)` block
      // (Algorithm 1) which the HTTP driver does not support.
      // The same handle services the `findClass` pre-flight
      // (one extra SELECT) so we don't open two connections
      // per booking attempt.
      const dbWrite = makeWriteDb(env.DB_URL);
      const repo = createDrizzleBookingRepo(dbWrite);
      const counter = createRedisRemainingCounter(redis);
      const publisher = createBookingEventPublisher();

      // The class's `studio_id` is resolved via `repo.findClass`
      // inside the service flow; the event envelopes however
      // need the studio id up-front. We fetch the class once
      // here to enrich the `studioId` field the service forwards
      // to the publisher. `bookClass` does its own null check
      // so a missing class simply falls through to the domain
      // `class_not_found` branch.
      const cls = await repo.findClass(input.classId);
      const studioId = cls?.studioId ?? '';

      const result = await svcBookClass({
        classId: input.classId,
        userId,
        studioId,
        repo,
        // Adapt `RemainingCounter` (`decr`/`incr`) → the
        // narrower `BookingCounter` shape the service
        // expects (`decrRemaining`/`incrRemaining`). The
        // names diverge so the booking flow's intent stays
        // visible at the call site without leaking the
        // concrete Redis primitive names.
        counter: {
          decrRemaining: (classId: string) => counter.decr(classId),
          incrRemaining: (classId: string) => counter.incr(classId),
        },
        publisher,
      });

      switch (result.code) {
        case 'ok':
          return {
            kind: 'confirmed',
            reservation: result.reservation,
          };
        case 'waitlisted':
          return {
            kind: 'waitlist',
            reservation: result.reservation,
            position: result.position,
          };
        case 'already_booked':
          return {
            kind: 'conflict',
            reservation: result.reservation,
          };
        case 'class_in_past':
          return { kind: 'class_in_past' };
        case 'class_not_found':
          return { kind: 'not_found' };
      }
    },

    async cancelReservation(userId, params) {
      // Per-request postgres-js client — Algorithm 2 needs an
      // interactive transaction with `SELECT FOR UPDATE` and
      // conditional waitlist promotion between statements.
      const dbWrite = makeWriteDb(env.DB_URL);
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
      const repo = createDrizzleCancelRepo(dbWrite);
      const counter = createRedisRemainingCounter(redis);

      const result = await svcCancelReservation({
        reservationId: params.reservationId,
        userId,
        repo,
        counter: {
          incrRemaining: async (classId: string) => {
            await counter.incr(classId);
          },
        },
      });

      switch (result.code) {
        case 'ok':
          return result.promoted !== null
            ? {
                kind: 'promoted',
                reservation: result.cancelled,
              }
            : {
                kind: 'cancelled',
                reservation: result.cancelled,
              };
        case 'not_found':
          return { kind: 'not_found' };
        case 'invalid_transition':
          return { kind: 'invalid_transition' };
        case 'cancellation_window_closed':
          return { kind: 'window_closed' };
      }
    },

    async getRemainingSeats(classId: string) {
      const redis = getOrCreateRedis(env.REDIS_URL, env.REDIS_TOKEN);
      const counter = createRedisRemainingCounter(redis);
      return counter.getRemaining(classId);
    },
  };
}

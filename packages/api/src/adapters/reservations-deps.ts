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
 *     and `cancelReservation` — use the postgres-js
 *     {@link AthlyaDb} via {@link createDb}. Without Hyperdrive the
 *     TCP client is rebuilt per request (Workers I/O scoping). With
 *     {@link AthlyaBindings.HYPERDRIVE} the write client is cached
 *     per isolate and pooled through Hyperdrive (issue #62).
 *
 * Read paths on the HTTP driver still filter at the query layer
 * (`studio_id` / `user_id`). Write paths (`bookClass`,
 * `cancelReservation`) use postgres-js {@link withTenant} so RLS
 * is active during interactive transactions (Req 13.1–13.6).
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2,
 *      7.3, 7.4, 8.1–8.6, 9.1–9.5, 10.1–10.5.
 */

import { type AthlyaDbHttp, type TenantClaims } from '@athlya/db/client';
import {
  listClasses as svcListClasses,
  createClass as svcCreateClass,
  bookClass as svcBookClass,
  createRedisRemainingCounter,
  searchClasses as svcSearchClasses,
} from '@athlya/reservations';
import { cancelReservation as svcCancelReservation } from '@athlya/reservations/cancel';
import { updateClass as svcUpdateClass } from '@athlya/reservations/update';

import {
  createDrizzleCreateClassRepoHttp,
  createDrizzleDeleteClassRepoHttp,
  createDrizzleListClassesRepoHttp,
  createDrizzleSearchClassesRepoHttp,
  createDrizzleUpdateClassRepo,
} from './classes-repo-drizzle.js';
import {
  getOrCreateDbHttp,
  getOrCreateDbHttpForRegion,
  getOrCreateRedisForEnv,
  getOrCreateWriteDb,
  primeDbHttpForTests,
  resetAllDepsCachesForTests,
} from './deps-cache.js';
import { createRedisInFlightLock } from './idempotency-in-flight.js';
import { listMyReservations as queryListMyReservations } from './reservations-list-drizzle.js';
import {
  createBookingEventPublisher,
  createDrizzleBookingRepo,
  createDrizzleCancelRepo,
} from './reservations-write-drizzle.js';
import { createTenantIdempotencyDb } from './tenant-idempotency.js';

import type { AuthClaims } from '../middleware/auth.js';
import type { ClassesDeps, DeleteClassOutcome, UpdateClassOutcome } from '../routes/classes.js';
import type { ReservationsDeps } from '../routes/reservations.js';
import type { AthlyaBindings } from '../types.js';
import type { ClassRow } from '@athlya/db/schema';
import type { ClassListing } from '@athlya/reservations';
import type { StudioId } from '@athlya/shared/ids';
import type {
  ClassSearchResult,
  CreateClassRequest,
  ListClassesQuery,
  SearchClassesQuery,
  UpdateClassRequest,
} from '@athlya/shared/schemas/api';

/* ------------------------------------------------------------------ */
/*  Per-isolate caches (HTTP DB + Redis) — shared via deps-cache       */
/* ------------------------------------------------------------------ */

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
export function buildClassesDeps(
  env: AthlyaBindings,
  cf?: { readonly continent?: string },
): ClassesDeps {
  return {
    async listClasses(
      studioId: string,
      range: ListClassesQuery,
      claims: AuthClaims,
    ): Promise<{ items: ClassListing[] }> {
      const db = getOrCreateDbHttpForRegion(env, cf?.continent);
      const redis = getOrCreateRedisForEnv(env);
      const classRepo = createDrizzleListClassesRepoHttp(db, toTenantClaims(claims));
      const counter = createRedisRemainingCounter(redis);
      const items = await svcListClasses(studioId, range, {
        classRepo,
        counter,
      });
      return { items };
    },

    async searchClasses(
      studioId: string,
      query: SearchClassesQuery,
      claims: AuthClaims,
    ): Promise<{ items: ClassSearchResult[] }> {
      const db = getOrCreateDbHttpForRegion(env, cf?.continent);
      const redis = getOrCreateRedisForEnv(env);
      const searchRepo = createDrizzleSearchClassesRepoHttp(db, toTenantClaims(claims));
      const counter = createRedisRemainingCounter(redis);

      const range =
        query.from !== undefined && query.to !== undefined
          ? { from: new Date(query.from), to: new Date(query.to) }
          : undefined;

      const items = await svcSearchClasses(studioId, query.q, range, {
        searchRepo,
        counter,
      });
      return { items };
    },

    async createClass(
      studioId: string,
      input: CreateClassRequest,
      claims: AuthClaims,
    ): Promise<ClassRow> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const redis = getOrCreateRedisForEnv(env);
      const classRepo = createDrizzleCreateClassRepoHttp(db, toTenantClaims(claims));
      const counter = createRedisRemainingCounter(redis);
      return svcCreateClass(studioId as StudioId, input, {
        classRepo,
        counter,
      });
    },

    async deleteClass(
      studioId: string,
      classId: string,
      claims: AuthClaims,
    ): Promise<DeleteClassOutcome> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const repo = createDrizzleDeleteClassRepoHttp(db, toTenantClaims(claims));
      const found = await repo.deleteClass(studioId, classId);
      return found ? { kind: 'deleted' } : { kind: 'not_found' };
    },

    async updateClass(
      studioId: string,
      classId: string,
      patch: UpdateClassRequest,
      claims: AuthClaims,
    ): Promise<UpdateClassOutcome> {
      const db = getOrCreateDbHttp(env.DB_URL);
      const redis = getOrCreateRedisForEnv(env);
      const classRepo = createDrizzleUpdateClassRepo(
        db,
        getOrCreateWriteDb(env),
        toTenantClaims(claims),
      );
      const counter = createRedisRemainingCounter(redis);

      try {
        const row = await svcUpdateClass(studioId, classId, patch, 'admin', {
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
        if (code === 'capacity_below_confirmed') return { kind: 'capacity_below_confirmed' };
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
function toTenantClaims(claims: AuthClaims): TenantClaims {
  return {
    userId: claims.userId,
    studioId: claims.studioId,
    role: claims.role,
  };
}

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
 * Write paths (interactive transactions, postgres-js):
 *   - `bookClass` / `cancelReservation` → {@link getOrCreateWriteDb}
 *     (Hyperdrive: cached per isolate; direct DB_URL: per request).
 */
export function buildReservationsDeps(
  env: AthlyaBindings,
  cf?: { readonly continent?: string },
): ReservationsDeps {
  return {
    async listMyReservations(userId: string, query, claims: AuthClaims) {
      const db = getOrCreateDbHttpForRegion(env, cf?.continent);
      return queryListMyReservations(userId, query, { db, claims: toTenantClaims(claims) });
    },

    async bookClass(claims, input) {
      const redis = getOrCreateRedisForEnv(env);

      const dbWrite = getOrCreateWriteDb(env);
      const repo = createDrizzleBookingRepo(dbWrite, toTenantClaims(claims));
      const counter = createRedisRemainingCounter(redis);
      const publisher = createBookingEventPublisher();

      // `svcBookClass` runs its own `findClass` pre-flight under RLS.
      // Outbox envelopes use the caller's studio — any class visible
      // to this tenant shares `claims.studioId` (cross-tenant → not_found).
      const result = await svcBookClass({
        classId: input.classId,
        userId: claims.userId,
        studioId: claims.studioId,
        repo,
        // Adapt `RemainingCounter` (`decr`/`incr`) → the
        // narrower `BookingCounter` shape the service
        // expects (`decrRemaining`/`incrRemaining`). The
        // names diverge so the booking flow's intent stays
        // visible at the call site without leaking the
        // concrete Redis primitive names.
        counter: {
          decrRemaining: (classId: string) => counter.decr(classId),
          decrRemainingOrInit: (classId: string, capacity: number) =>
            counter.decrOrInit(classId, capacity),
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
            status: result.reservation.status === 'waitlist' ? 'waitlist' : 'confirmed',
            reservation: result.reservation,
            ...(result.position !== undefined ? { position: result.position } : {}),
          };
        case 'class_in_past':
          return { kind: 'class_in_past' };
        case 'class_not_found':
          return { kind: 'not_found' };
        case 'counter_unavailable':
          return { kind: 'counter_unavailable' };
      }
    },

    async cancelReservation(claims, params) {
      const dbWrite = getOrCreateWriteDb(env);
      const redis = getOrCreateRedisForEnv(env);
      const repo = createDrizzleCancelRepo(dbWrite, toTenantClaims(claims));
      const counter = createRedisRemainingCounter(redis);

      const result = await svcCancelReservation({
        reservationId: params.reservationId,
        userId: claims.userId,
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
        case 'already_cancelled':
          return { kind: 'already_cancelled', reservation: result.cancelled };
        case 'not_found':
          return { kind: 'not_found' };
        case 'invalid_transition':
          return { kind: 'invalid_transition' };
        case 'cancellation_window_closed':
          return { kind: 'window_closed' };
      }
    },

    async getRemainingSeats(classId: string) {
      const redis = getOrCreateRedisForEnv(env);
      const counter = createRedisRemainingCounter(redis);
      return counter.getRemaining(classId);
    },

    // Strict mode: a duplicate booking or cancel costs a seat, so the
    // routes refuse to run unprotected (503) rather than degrade.
    idempotencyFor(claims) {
      return {
        db: createTenantIdempotencyDb(getOrCreateDbHttp(env.DB_URL), toTenantClaims(claims)),
        inFlight: createRedisInFlightLock(getOrCreateRedisForEnv(env)),
        bindRequest: true,
        failClosed: true,
      };
    },
  };
}

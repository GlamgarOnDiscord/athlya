/**
 * Integration-test infrastructure for the full gateway pipeline
 * (task 8.12).
 *
 * H4 shipped middleware-chain tests (`__tests__/middleware-chain.test.ts`)
 * and task 8.11 shipped per-domain router tests
 * (`__tests__/routes/*.test.ts`). Neither exercises a multi-route
 * USER JOURNEY through the production `/v1/*` domain routers with
 * stateful deps that propagate across requests.
 *
 * This helper composes a `buildApp({ deps })` instance backed by a
 * stateful {@link IntegrationState} and wires every cross-cutting
 * concern the integration tests need:
 *
 *   • Stateful `DomainDeps` stubs — each `vi.fn()` records its
 *     effect onto `state` so subsequent requests (book → cancel,
 *     admin create → member list) observe the mutation.
 *   • A `buildIntegrationApp` factory that also supports injecting
 *     a `rateLimit` middleware ahead of the reservations router,
 *     keeping the production `buildApp` untouched.
 *   • Event recorder — every happy-path stub appends to
 *     `state.events` so tests can assert `auth.user.registered`,
 *     `reservation.created` and `reservation.promoted` flows.
 *   • Idempotency-key store backed by an in-memory `Map` so the
 *     cached-replay invariant can be exercised without a real DB.
 *
 * Everything else (RS256 keypair, local JWKS resolver, FakeRedis,
 * buildMockEnv) is re-exported verbatim from the H4 test helpers
 * so the two suites stay in lock-step.
 */

import { vi } from 'vitest';

import { jwtAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { mountDomainRoutes } from '../../routes/index.js';
import { buildApp } from '../../worker.js';
import { buildAppNoDomainRoutes } from '../helpers/test-app.js';
import {
  FakeRedis,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
  type TestKeypair,
} from '../helpers/test-app.js';

import type { AuthClaims, JwksKeyResolver } from '../../middleware/auth.js';
import type { IdempotencyMiddlewareDeps } from '../../middleware/idempotency.js';
import type { RateLimitOptions } from '../../middleware/rate-limit.js';
import type { CheckinsDeps, DomainDeps, SessionsDeps } from '../../routes/index.js';
import type { HonoEnv } from '../../types.js';
import type { CheckInResponse } from '@athlya/shared/schemas/api';
import type { WorkoutSession } from '@athlya/shared/schemas/domain';
import type { Redis } from '@upstash/redis';
import type { Hono } from 'hono';

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

export {
  FakeRedis,
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
};
export type { TestKeypair };

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

/** Lightweight user record kept in the in-memory tenant store. */
export interface UserRecord {
  readonly userId: string;
  readonly email: string;
  readonly studioId: string;
  readonly displayName: string;
  readonly role: AuthClaims['role'];
}

/** Lightweight reservation record. `status` transitions over the journey. */
export interface ReservationRecord {
  id: string;
  classId: string;
  userId: string;
  status: 'confirmed' | 'waitlist' | 'cancelled';
  position?: number;
}

/** Lightweight class record kept in the in-memory tenant store. */
export interface ClassRecord {
  id: string;
  title: string;
  studioId: string;
  capacity: number;
  startsAt: string;
}

/**
 * Cached idempotency-key payload. Mirrors the `response + statusCode`
 * shape written by the DB helper so the mocked `@athlya/db/idempotency`
 * module is a drop-in substitute.
 */
export interface IdempotencyRecord {
  readonly response: Record<string, unknown>;
  readonly statusCode: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Recorded business event — a minimal subset of the production envelope. */
export interface RecordedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Stateful integration-test universe. Tests mutate this object
 * through the deps stubs; the assertions then read it back.
 */
export interface IntegrationState {
  readonly users: Map<string, UserRecord>;
  readonly usersByEmail: Map<string, UserRecord>;
  readonly classes: Map<string, ClassRecord>;
  readonly reservationsById: Map<string, ReservationRecord>;
  /** `classId → reservations ordered by creation`. Used for waitlist. */
  readonly reservationsByClass: Map<string, ReservationRecord[]>;
  readonly idempotencyStore: Map<string, IdempotencyRecord>;
  readonly events: RecordedEvent[];
}

/** Build a fresh, empty integration state. */
export function createIntegrationState(): IntegrationState {
  return {
    users: new Map(),
    usersByEmail: new Map(),
    classes: new Map(),
    reservationsById: new Map(),
    reservationsByClass: new Map(),
    idempotencyStore: new Map(),
    events: [],
  };
}

/* ------------------------------------------------------------------ */
/*  UUID helpers                                                       */
/* ------------------------------------------------------------------ */

/** Deterministic-ish UUID v4 factory so tests stay reproducible. */
export function makeUuid(prefix: number): string {
  const hex = prefix.toString(16).padStart(4, '0');
  return `${hex}0000-0000-4000-8000-000000000000`.padStart(36, '0');
}

/* ------------------------------------------------------------------ */
/*  JWT minting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Mint a JWT bearer token for a synthetic user.
 *
 * Mirrors `mintAuthJwt` from the route test helpers but with an
 * explicit `expSec` override so the "expired token" integration
 * test can produce a JWT whose `exp` sits in the past.
 */
export async function signUserJwt(
  kp: TestKeypair,
  params: {
    readonly userId?: string;
    readonly studioId?: string;
    readonly role?: AuthClaims['role'];
    readonly expSec?: number;
    readonly iatSec?: number;
  } = {},
): Promise<string> {
  const opts: Parameters<typeof signTestJwt>[2] = {};
  if (params.expSec !== undefined) opts.expSec = params.expSec;
  if (params.iatSec !== undefined) opts.iatSec = params.iatSec;
  return signTestJwt(
    kp.privateKey,
    {
      sub: params.userId ?? TEST_USER_ID,
      studio: params.studioId ?? TEST_STUDIO_ID,
      role: params.role ?? 'member',
    },
    opts,
  );
}

/* ------------------------------------------------------------------ */
/*  Stateful DomainDeps                                                */
/* ------------------------------------------------------------------ */

/**
 * Options controlling the behaviour of {@link buildIntegrationDeps}.
 *
 * `signSessionToken` is REQUIRED: the returned session must carry a
 * JWT signed with the same RS256 keypair the auth middleware's
 * resolver knows, otherwise the subsequent authenticated requests in
 * the journey surface as 401.
 */
export interface IntegrationDepsOptions {
  readonly state: IntegrationState;
  /** Produces a bearer token for a newly-registered / logged-in user. */
  signSessionToken(user: UserRecord): Promise<string>;
  /** When set, the reservations router wires the idempotency middleware. */
  readonly idempotencyDb?: unknown;
}

/**
 * Build a {@link DomainDeps} bundle whose methods mutate a shared
 * {@link IntegrationState}.
 *
 * Every method is a `vi.fn()` spy so tests can assert call counts,
 * and every method records its effect on `state` so downstream
 * requests observe the mutation. Event-emitting mutations append to
 * `state.events` so the journey's event flow can be verified in one
 * place.
 */
export function buildIntegrationDeps(options: IntegrationDepsOptions): DomainDeps {
  const { state, signSessionToken } = options;

  /* --------------------- auth ---------------------- */
  const auth: DomainDeps['auth'] = {
    register: vi.fn(
      async (input: {
        readonly email: string;
        readonly displayName: string;
        readonly studioSlug: string;
      }) => {
        const userId = makeUuid(state.users.size + 1);
        const studioId = TEST_STUDIO_ID;
        const user: UserRecord = {
          userId,
          email: input.email,
          studioId,
          displayName: input.displayName,
          role: 'member',
        };
        state.users.set(userId, user);
        state.usersByEmail.set(input.email.toLowerCase(), user);
        state.events.push({
          type: 'auth.user.registered',
          payload: { userId, studioId, email: input.email },
        });
        const accessToken = await signSessionToken(user);
        return {
          user: {
            id: userId,
            email: input.email,
            displayName: input.displayName,
            studioId,
          },
          accessToken,
          refreshToken: `refresh.${userId}`,
          accessTokenExpiresIn: 900,
          refreshTokenExpiresIn: 2_592_000,
        };
      },
    ),
    login: vi.fn(async (input: { readonly email: string }) => {
      const user = state.usersByEmail.get(input.email.toLowerCase());
      if (user === undefined) {
        throw new Error('user not found');
      }
      const accessToken = await signSessionToken(user);
      return {
        user: {
          id: user.userId,
          email: user.email,
          displayName: user.displayName,
          studioId: user.studioId,
        },
        accessToken,
        refreshToken: `refresh.${user.userId}`,
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 2_592_000,
      };
    }),
    refresh: vi.fn(async () => {
      throw new Error('refresh not used in integration suite');
    }),
    logout: vi.fn(async () => undefined),
    logoutAll: vi.fn(async () => undefined),
    deleteMe: vi.fn(async () => undefined),
    requestPasswordReset: vi.fn(async () => undefined),
    confirmPasswordReset: vi.fn(async () => undefined),
  };

  /* --------------------- classes -------------------- */
  const classes: DomainDeps['classes'] = {
    listClasses: vi.fn(async (studioId: string) => {
      const items: ClassRecord[] = [];
      for (const cls of state.classes.values()) {
        if (cls.studioId === studioId) items.push(cls);
      }
      return { items };
    }),
    createClass: vi.fn(
      async (
        studioId: string,
        input: {
          readonly title: string;
          readonly startsAt: string;
          readonly capacity: number;
        },
      ) => {
        const classId = makeUuid(1000 + state.classes.size);
        const cls: ClassRecord = {
          id: classId,
          title: input.title,
          studioId,
          capacity: input.capacity,
          startsAt: input.startsAt,
        };
        state.classes.set(classId, cls);
        state.events.push({
          type: 'class.created',
          payload: { classId, studioId },
        });
        return cls;
      },
    ),
    searchClasses: vi.fn(async () => ({ items: [] })),
    updateClass: vi.fn(async () => ({ kind: 'not_found' as const })),
    deleteClass: vi.fn(async () => ({ kind: 'not_found' as const })),
  };

  /* --------------------- reservations --------------- */
  const reservations: DomainDeps['reservations'] = {
    bookClass: vi.fn(
      async (
        claims: { readonly userId: string; readonly studioId: string },
        input: { readonly classId: string },
      ) => {
        const cls = state.classes.get(input.classId);
        if (cls === undefined || cls.studioId !== claims.studioId) {
          return { kind: 'not_found' as const };
        }
        const userId = claims.userId;
        const resId = makeUuid(2000 + state.reservationsById.size);
        const existing = state.reservationsByClass.get(input.classId) ?? [];
        const confirmedCount = existing.filter((r) => r.status === 'confirmed').length;
        if (confirmedCount < cls.capacity) {
          const r: ReservationRecord = {
            id: resId,
            classId: input.classId,
            userId,
            status: 'confirmed',
          };
          existing.push(r);
          state.reservationsById.set(resId, r);
          state.reservationsByClass.set(input.classId, existing);
          state.events.push({
            type: 'reservation.created',
            payload: { reservationId: resId, classId: input.classId, userId },
          });
          return { kind: 'confirmed' as const, reservation: r };
        }
        // Waitlist
        const position = existing.filter((r) => r.status === 'waitlist').length + 1;
        const r: ReservationRecord = {
          id: resId,
          classId: input.classId,
          userId,
          status: 'waitlist',
          position,
        };
        existing.push(r);
        state.reservationsById.set(resId, r);
        state.reservationsByClass.set(input.classId, existing);
        state.events.push({
          type: 'reservation.waitlisted',
          payload: { reservationId: resId, classId: input.classId, userId, position },
        });
        return { kind: 'waitlist' as const, reservation: r, position };
      },
    ),
    cancelReservation: vi.fn(
      async (claims: { readonly userId: string }, params: { readonly reservationId: string }) => {
        const r = state.reservationsById.get(params.reservationId);
        if (r === undefined || r.userId !== claims.userId) {
          return { kind: 'not_found' as const };
        }
        r.status = 'cancelled';
        state.events.push({
          type: 'reservation.cancelled',
          payload: { reservationId: r.id, classId: r.classId, userId: claims.userId },
        });
        // Waitlist promotion: the first waitlisted reservation on the
        // same class flips to 'confirmed'.
        const siblings = state.reservationsByClass.get(r.classId) ?? [];
        const nextWaitlisted = siblings.find((s) => s.status === 'waitlist');
        if (nextWaitlisted !== undefined) {
          nextWaitlisted.status = 'confirmed';
          delete nextWaitlisted.position;
          state.events.push({
            type: 'reservation.promoted',
            payload: {
              reservationId: nextWaitlisted.id,
              classId: r.classId,
              userId: nextWaitlisted.userId,
            },
          });
          return { kind: 'promoted' as const, reservation: r };
        }
        return { kind: 'cancelled' as const, reservation: r };
      },
    ),
    listMyReservations: vi.fn(async (userId: string) => {
      const items: ReservationRecord[] = [];
      for (const r of state.reservationsById.values()) {
        if (r.userId === userId) items.push(r);
      }
      return { items, nextCursor: null };
    }),
    getRemainingSeats: vi.fn(async (_classId: string) => null),
  };

  if (options.idempotencyDb !== undefined) {
    const idempotencyDb = options.idempotencyDb as IdempotencyMiddlewareDeps['db'];
    reservations.idempotencyFor = () => ({ db: idempotencyDb, ttlSec: 60 });
  }

  /* --------------------- sessions / checkins / members --------- */
  const sessions: SessionsDeps = {
    logSession: vi.fn(async () => ({
      kind: 'created' as const,
      session: { id: 'session-1' } as unknown as WorkoutSession,
    })),
    listSessions: vi.fn(async () => []),
  };

  const checkins: CheckinsDeps = {
    issueToken: vi.fn(async () => ({
      token: 'a.b.c',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })),
    checkIn: vi.fn(async () => {
      // The integration tests do not verify the QR token itself
      // (Epic 11 owns that). We simulate a successful check-in:
      // the operator's JWT already proved tenant scope via jwtAuth.
      state.events.push({
        type: 'checkin.recorded',
        payload: { at: new Date().toISOString() },
      });
      return {
        kind: 'success' as const,
        reservationId: makeUuid(4242) as CheckInResponse['reservationId'],
        member: {
          id: TEST_USER_ID as CheckInResponse['member']['id'],
          displayName: 'Test',
          avatarUrl: null,
        },
      };
    }),
  };

  const members: DomainDeps['members'] = {
    getProfile: vi.fn(async (userId: string) => {
      const u = state.users.get(userId);
      if (u === undefined) {
        throw new Error('member profile not found');
      }
      return { id: u.userId, displayName: u.displayName, email: u.email };
    }),
    updateProfile: vi.fn(async () => ({})),
    uploadAvatar: vi.fn(async () => ({ avatarUrl: 'https://avatars.athlya.app/test.jpg' })),
    updateConsents: vi.fn(async () => ({})),
    enqueueExport: vi.fn(async () => ({ jobId: makeUuid(9999) })),
    getExportJob: vi.fn(async () => null),
    openExportDownload: vi.fn(async () => ({ kind: 'not_found' as const })),
    listMembersByStudio: vi.fn(async () => ({ items: [], nextCursor: null })),
    getProgression: vi.fn(async (_userId: string, windowDays: 30 | 90 | 365) => ({
      windowDays,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
      totals: { sessions: 0, volumeKg: 0 },
      exercises: [],
      weeklyFrequency: [],
      truncated: false,
      skippedSessions: 0,
    })),
    getCardioProgression: vi.fn(
      async (_userId: string, windowDays: 30 | 90 | 365, bucket: 'day' | 'week') => ({
        windowDays,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
        bucket,
        totals: { sessions: 0, durationSec: 0, distanceM: 0, energyKcal: 0 },
        machines: [],
        truncated: false,
        skippedSessions: 0,
      }),
    ),
  };

  /* --------------------- studios --------------------- */
  const studios: DomainDeps['studios'] = {
    getStudio: vi.fn(async (studioId: string) => {
      // Best-effort lookup against the seeded studio set. The
      // integration suite seeds two studios via `seedTwoStudios`
      // (Studio A + Studio B); a request for any other id
      // resolves to `null` so the route renders 404.
      const studioMap: Record<
        string,
        {
          slug: string;
          name: string;
          brandColor: string;
        }
      > = {
        [STUDIO_A_ID]: {
          slug: 'athlya-paris',
          name: 'Athlya Paris',
          brandColor: '#0EA5E9',
        },
        [STUDIO_B_ID]: {
          slug: 'athlya-lyon',
          name: 'Athlya Lyon',
          brandColor: '#22C55E',
        },
      };
      const seed = studioMap[studioId];
      if (seed === undefined) return null;
      return {
        id: studioId,
        slug: seed.slug,
        name: seed.name,
        brandColor: seed.brandColor,
        brandLogo: null,
      };
    }),
    updateStudio: vi.fn(async (studioId: string, patch) => {
      // Echo the patch back as if the row existed and was
      // mutated. Tests overriding this stub can return `null` to
      // simulate a vanished tenant row.
      return {
        id: studioId,
        slug: 'athlya-paris',
        name: patch.name ?? 'Athlya Paris',
        brandColor: patch.brandColor ?? '#0EA5E9',
        brandLogo: patch.brandLogo ?? null,
      };
    }),
  };

  /* --------------------- billing --------------------- */
  const billing: DomainDeps['billing'] = {
    createCheckoutSession: vi.fn(async () => ({
      kind: 'not_configured' as const,
    })),
    listInvoices: vi.fn(async () => ({ items: [], nextCursor: null })),
    handleWebhook: vi.fn(async () => ({ kind: 'ok' as const })),
  };

  const audit = {
    listAuditLog: vi.fn(async () => ({ items: [], nextCursor: null })),
  };

  const coach: DomainDeps['coach'] = {
    isEnabled: vi.fn(async () => false),
    getStatus: vi.fn(async () => ({ enabled: false as const })),
    ask: vi.fn(async () => {
      throw new Error('coach disabled in integration tests');
    }),
    askStream: vi.fn(async () => {
      throw new Error('coach disabled in integration tests');
    }),
  };

  return {
    auth,
    classes,
    reservations,
    sessions,
    checkins,
    members,
    studios,
    billing,
    audit,
    coach,
  };
}

/* ------------------------------------------------------------------ */
/*  App factory                                                        */
/* ------------------------------------------------------------------ */

/**
 * Options accepted by {@link buildIntegrationApp}.
 *
 * `rateLimit` is optional — when present, the helper wires a
 * `jwtAuth` + `rateLimit` pair ahead of the reservations router so
 * the user-bucket semantics can be exercised end-to-end (the
 * production routers don't mount rate-limit themselves yet; task
 * 8.11 left that to a future hardening pass). When absent, the
 * default `buildApp({ deps })` composition is returned unchanged.
 */
export interface BuildIntegrationAppOptions {
  readonly deps: DomainDeps;
  readonly jwksResolver: JwksKeyResolver;
  readonly rateLimit?: {
    readonly redis: Redis;
    readonly userLimit?: number;
    readonly ipLimit?: number;
    readonly windowSec?: number;
  };
}

/**
 * Build the integration-test app.
 *
 * When `options.rateLimit` is present, the factory composes:
 *
 *   buildAppNoDomainRoutes({ deps })
 *     → app.use('/v1/reservations/*', jwtAuth({ keyResolver }))
 *     → app.use('/v1/reservations/*', rateLimit({ ... }))
 *     → mountDomainRoutes(app, deps)
 *
 * The inline `jwtAuth` ahead of `rateLimit` is load-bearing: rate
 * limit reads `authClaims.userId` to pick the user bucket, and the
 * routers' internal `jwtAuth()` runs later (and harmlessly
 * re-verifies the same token — the JWKS cache absorbs the cost).
 * H4's `middleware-chain.test.ts` exercises the same ordering on
 * `/v1/test/authed`; this helper lifts it onto the real route.
 *
 * Sprint 11 / Slice 11.1 (critique C2.2) — historically used
 * `buildApp({ skipDomainRoutes: true })`. The flag was demoted to a
 * test-only seam; this helper now imports
 * {@link buildAppNoDomainRoutes} from the dedicated test helpers
 * module instead.
 */
export function buildIntegrationApp(options: BuildIntegrationAppOptions): Hono<HonoEnv> {
  if (options.rateLimit === undefined) {
    return buildApp({ deps: options.deps });
  }

  // Custom composition so rate-limit can sit between app-level auth
  // and the reservations router. `buildAppNoDomainRoutes()`
  // suppresses the default mount so we can slide middleware in
  // between, then `mountDomainRoutes()` runs at the bottom of the
  // chain.
  const app = buildAppNoDomainRoutes({ deps: options.deps });

  const rlOpts: RateLimitOptions = { redis: options.rateLimit.redis };
  if (options.rateLimit.userLimit !== undefined) {
    (rlOpts as { userLimit: number }).userLimit = options.rateLimit.userLimit;
  }
  if (options.rateLimit.ipLimit !== undefined) {
    (rlOpts as { ipLimit: number }).ipLimit = options.rateLimit.ipLimit;
  }
  if (options.rateLimit.windowSec !== undefined) {
    (rlOpts as { windowSec: number }).windowSec = options.rateLimit.windowSec;
  }

  app.use('/v1/reservations/*', jwtAuth({ keyResolver: options.jwksResolver }));
  app.use('/v1/reservations/*', rateLimit(rlOpts));

  mountDomainRoutes(app, options.deps);
  return app;
}

/* ------------------------------------------------------------------ */
/*  Two-studio seeding — task 15.3                                     */
/* ------------------------------------------------------------------ */

/**
 * Stable UUID v4 literals used by {@link seedTwoStudios} and the
 * `multi-tenant-isolation.integration.test.ts` suite.
 *
 * The suite asserts cross-tenant isolation (Req 13.2, 13.3, 13.5),
 * so each id has to be distinct from the single-tenant helpers
 * above (`TEST_STUDIO_ID`, `TEST_USER_ID`) to catch any accidental
 * state bleed between the two helper flavours.
 */
export const STUDIO_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const STUDIO_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const ALICE_ID = 'a11ce000-0000-4000-8000-000000000001';
export const BOB_ID = 'b0bb0000-0000-4000-8000-000000000002';
export const ADMIN_A_ID = 'ad310000-0000-4000-8000-000000000003';

/** Class id seeded inside Studio A. */
export const CLASS_A_ID = 'c1a55000-0000-4000-8000-00000000000a';
/** Class id seeded inside Studio B. */
export const CLASS_B_ID = 'c1a55000-0000-4000-8000-00000000000b';
/** Reservation seeded for Alice (inside Studio A). */
export const RESERVATION_A_ID = '4e5e4000-0000-4000-8000-00000000000a';
/** Reservation seeded for Bob (inside Studio B). */
export const RESERVATION_B_ID = '4e5e4000-0000-4000-8000-00000000000b';

/**
 * Seed an {@link IntegrationState} with two studios, three users,
 * two classes and two reservations — one reservation per member in
 * their own studio.
 *
 * Layout:
 *
 *   Studio A (`STUDIO_A_ID`, slug `athlya-paris`)
 *     ├─ Alice      (member, `ALICE_ID`)
 *     ├─ Admin A    (admin,  `ADMIN_A_ID`)
 *     ├─ Class A    (`CLASS_A_ID`, capacity 10)
 *     └─ Reservation A (Alice → Class A, `RESERVATION_A_ID`)
 *
 *   Studio B (`STUDIO_B_ID`, slug `athlya-lyon`)
 *     ├─ Bob        (member, `BOB_ID`)
 *     ├─ Class B    (`CLASS_B_ID`, capacity 10)
 *     └─ Reservation B (Bob → Class B, `RESERVATION_B_ID`)
 *
 * The stateful {@link buildIntegrationDeps} stubs already filter by
 * `studioId` (`listClasses`) and `userId`
 * (`listMyReservations` / `cancelReservation`), so this seed is
 * sufficient to drive every cross-tenant assertion in
 * `multi-tenant-isolation.integration.test.ts`.
 */
export function seedTwoStudios(state: IntegrationState): void {
  /* users */
  const alice: UserRecord = {
    userId: ALICE_ID,
    email: 'alice@studio-a.example',
    studioId: STUDIO_A_ID,
    displayName: 'Alice',
    role: 'member',
  };
  const bob: UserRecord = {
    userId: BOB_ID,
    email: 'bob@studio-b.example',
    studioId: STUDIO_B_ID,
    displayName: 'Bob',
    role: 'member',
  };
  const adminA: UserRecord = {
    userId: ADMIN_A_ID,
    email: 'admin@studio-a.example',
    studioId: STUDIO_A_ID,
    displayName: 'Studio-A Admin',
    role: 'admin',
  };
  state.users.set(alice.userId, alice);
  state.users.set(bob.userId, bob);
  state.users.set(adminA.userId, adminA);
  state.usersByEmail.set(alice.email, alice);
  state.usersByEmail.set(bob.email, bob);
  state.usersByEmail.set(adminA.email, adminA);

  /* classes */
  const classA: ClassRecord = {
    id: CLASS_A_ID,
    title: 'Morning yoga',
    studioId: STUDIO_A_ID,
    capacity: 10,
    startsAt: '2099-01-01T09:00:00.000Z',
  };
  const classB: ClassRecord = {
    id: CLASS_B_ID,
    title: 'Evening HIIT',
    studioId: STUDIO_B_ID,
    capacity: 10,
    startsAt: '2099-01-01T19:00:00.000Z',
  };
  state.classes.set(classA.id, classA);
  state.classes.set(classB.id, classB);

  /* reservations */
  const reservationA: ReservationRecord = {
    id: RESERVATION_A_ID,
    classId: CLASS_A_ID,
    userId: ALICE_ID,
    status: 'confirmed',
  };
  const reservationB: ReservationRecord = {
    id: RESERVATION_B_ID,
    classId: CLASS_B_ID,
    userId: BOB_ID,
    status: 'confirmed',
  };
  state.reservationsById.set(reservationA.id, reservationA);
  state.reservationsById.set(reservationB.id, reservationB);
  state.reservationsByClass.set(CLASS_A_ID, [reservationA]);
  state.reservationsByClass.set(CLASS_B_ID, [reservationB]);
}

/**
 * Shared helpers for the `/v1/*` route tests (task 8.11).
 *
 * Composes a fresh {@link buildApp} with a custom `deps` bundle so
 * each test exercises ONE domain router backed by `vi.fn()` doubles.
 * The global middleware chain (security headers, tracing, serve-log,
 * OTel, Problem Details error handlers, 404) is kept intact so the
 * assertions reflect production wiring.
 *
 * The auth middleware's JWKS cache is cleared between tests via
 * `__resetJwksCacheForTests`, so the module-scoped pool does not
 * leak across suites.
 */

import { vi } from 'vitest';

import { __resetJwksCacheForTests } from '../../middleware/auth.js';
import { buildApp } from '../../worker.js';
import {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
  type TestKeypair,
} from '../helpers/test-app.js';

import type { AuthClaims } from '../../middleware/auth.js';
import type { DomainDeps } from '../../routes/index.js';
import type { AthlyaBindings, HonoEnv } from '../../types.js';
import type { Hono } from 'hono';

export {
  TEST_STUDIO_ID,
  TEST_USER_ID,
  buildLocalResolver,
  buildMockEnv,
  mintTestKeypair,
  signTestJwt,
};
export type { TestKeypair };

/**
 * Mint a JWT using the shape the auth middleware expects: `sub`,
 * `studio`, `role`. Callers override any of the three via `claims`.
 */
export async function mintAuthJwt(
  kp: TestKeypair,
  claims: Partial<AuthClaims> = {},
): Promise<string> {
  return signTestJwt(kp.privateKey, {
    sub: claims.userId ?? TEST_USER_ID,
    studio: claims.studioId ?? TEST_STUDIO_ID,
    role: claims.role ?? 'member',
  });
}

/**
 * Build a `DomainDeps` bundle where every method is a `vi.fn()` spy.
 * Callers override specific methods per test via `overrides`. No
 * `idempotency` field is set so the routers skip the idempotency
 * middleware (see the `...(idem ? [...] : [])` guard).
 */
export function buildStubDeps(
  overrides: {
    auth?: Partial<DomainDeps['auth']>;
    members?: Partial<DomainDeps['members']>;
    classes?: Partial<DomainDeps['classes']>;
    reservations?: Partial<DomainDeps['reservations']>;
    sessions?: Partial<DomainDeps['sessions']>;
    checkins?: Partial<DomainDeps['checkins']>;
    studios?: Partial<DomainDeps['studios']>;
    billing?: Partial<DomainDeps['billing']>;
    audit?: Partial<DomainDeps['audit']>;
    coach?: Partial<DomainDeps['coach']>;
  } = {},
): DomainDeps {
  return {
    auth: {
      register: vi.fn(),
      login: vi.fn(),
      refresh: vi.fn(),
      logout: vi.fn(),
      logoutAll: vi.fn(),
      deleteMe: vi.fn(),
      requestPasswordReset: vi.fn(),
      confirmPasswordReset: vi.fn(),
      ...overrides.auth,
    },
    members: {
      getProfile: vi.fn(),
      updateProfile: vi.fn(),
      uploadAvatar: vi.fn(),
      updateConsents: vi.fn(),
      enqueueExport: vi.fn(),
      getExportJob: vi.fn(),
      openExportDownload: vi.fn(),
      listMembersByStudio: vi.fn(),
      getProgression: vi.fn(),
      getCardioProgression: vi.fn(),
      ...overrides.members,
    },
    classes: {
      listClasses: vi.fn(),
      searchClasses: vi.fn(),
      createClass: vi.fn(),
      updateClass: vi.fn(),
      deleteClass: vi.fn(),
      ...overrides.classes,
    },
    reservations: {
      bookClass: vi.fn(),
      cancelReservation: vi.fn(),
      listMyReservations: vi.fn(),
      getRemainingSeats: vi.fn(),
      ...overrides.reservations,
    },
    sessions: {
      logSession: vi.fn(),
      listSessions: vi.fn(),
      ...overrides.sessions,
    },
    checkins: {
      issueToken: vi.fn(),
      checkIn: vi.fn(),
      ...overrides.checkins,
    },
    studios: {
      getStudio: vi.fn(),
      updateStudio: vi.fn(),
      ...overrides.studios,
    },
    billing: {
      createCheckoutSession: vi.fn(),
      listInvoices: vi.fn(),
      handleWebhook: vi.fn(),
      ...overrides.billing,
    },
    audit: {
      listAuditLog: vi.fn(),
      ...overrides.audit,
    },
    coach: {
      isEnabled: vi.fn(() => Promise.resolve(false)),
      getStatus: vi.fn(),
      ask: vi.fn(),
      askStream: vi.fn(),
      ...overrides.coach,
    },
  };
}

/**
 * Build a plain app with domain routes wired from `deps`. Resets the
 * JWKS cache so cross-test pollution cannot occur.
 */
export function buildTestApp(deps: DomainDeps): Hono<HonoEnv> {
  __resetJwksCacheForTests();
  return buildApp({ deps });
}

/** Build a mock AthlyaBindings env. */
export function env(overrides: Partial<AthlyaBindings> = {}): AthlyaBindings {
  return buildMockEnv(overrides);
}

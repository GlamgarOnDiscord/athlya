/**
 * Rate-limit coverage registry — issue #133.
 *
 * Single source of truth for the route × policy matrix documented in
 * `docs/security/rate-limit-coverage.md`. Worker wiring imports budgets
 * from here; tests assert fail-policy invariants table-driven.
 */

import type { LimiterFailPolicy } from './limiter-guard.js';

export interface RateLimitBudget {
  readonly userLimit?: number;
  readonly ipLimit?: number;
  readonly windowSec: number;
}

export interface RateLimitCoverageRow {
  readonly id: string;
  readonly route: string;
  readonly methods: string;
  readonly budget: RateLimitBudget | 'default' | 'studio-default';
  readonly failPolicy: LimiterFailPolicy;
  readonly bucket: 'ip' | 'user' | 'ip+user' | 'studio';
  readonly wiredIn: 'worker.ts' | 'domain-router';
  readonly notes?: string;
}

/** GET admin stats probed during Redis outages (fail-closed). */
export const ADMIN_STATS_GET_PATHS = [
  '/admin/dlq/stats',
  '/admin/outbox/stats',
  '/admin/jwt/state',
] as const;

export const EXPENSIVE_READ_BUDGET: RateLimitBudget = {
  userLimit: 30,
  ipLimit: 30,
  windowSec: 60,
};

export const MEMBERS_LIST_BUDGET: RateLimitBudget = {
  userLimit: 20,
  ipLimit: 20,
  windowSec: 60,
};

export const ADMIN_STATS_BUDGET: RateLimitBudget = {
  userLimit: 10,
  ipLimit: 5,
  windowSec: 60,
};

export const AUTH_BUDGET = { ipLimit: 20, windowSec: 60 } as const satisfies RateLimitBudget;

export const LOGIN_BUDGET: RateLimitBudget = { ipLimit: 5, windowSec: 60 };
export const REGISTER_BUDGET: RateLimitBudget = { ipLimit: 10, windowSec: 60 };
export const FORGOT_PASSWORD_BUDGET: RateLimitBudget = { ipLimit: 3, windowSec: 60 };

/** Issue #240 — per-user refresh throttle (10 per 15-min window). */
export const REFRESH_BUDGET: RateLimitBudget = { userLimit: 10, windowSec: 900 };

/**
 * Per-user only (issue #613): the gateway authenticates before these
 * limiters, so no request reaching them falls back to an IP bucket.
 */
export const MUTATION_BUDGETS = {
  reservation: { userLimit: 10, windowSec: 60 },
  profile: { userLimit: 5, windowSec: 60 },
  export: { userLimit: 1, windowSec: 86400 },
  coach: { userLimit: 5, windowSec: 60 },
  /**
   * Issue #652 — workout session log, above the booking budget so a
   * typical offline backlog drains in one pass. A backlog above 20
   * sessions gets 429s: the drain's retries (about 30 s in total) end
   * before the 60 s window frees up, so the rest stays queued, in order,
   * until the next drain.
   */
  session: { userLimit: 20, windowSec: 60 },
} as const satisfies Record<string, RateLimitBudget>;

/**
 * `POST /v1/checkins` is called by the kiosk operator (admin or coach,
 * issue #654), so the bucket is per operator: one scan per second
 * sustained covers a class starting. The per-member bound of issue
 * #338 is structural now: a check-in needs a single-use QR token and a
 * confirmed reservation within ±30 min, and stamps it only once.
 */
export const CHECKIN_BUDGET: RateLimitBudget = { userLimit: 60, windowSec: 60 };

/**
 * `POST /v1/checkins/token` (issue #654). The app rotates the QR every
 * 120 s; the headroom covers reopening the screen a few times.
 */
export const CHECKIN_TOKEN_BUDGET: RateLimitBudget = { userLimit: 10, windowSec: 60 };

/**
 * Authoritative coverage matrix. Keep in sync with `worker.ts` mounts and
 * `studioRateLimit()` on domain routers.
 */
export const RATE_LIMIT_COVERAGE: readonly RateLimitCoverageRow[] = [
  {
    id: 'global-v1',
    route: '/v1/*',
    methods: '*',
    budget: 'default',
    failPolicy: 'fail-open',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #322 — fail-open: Redis outage lets requests through; mutation limiters stay fail-closed',
  },
  {
    id: 'auth',
    route: '/v1/auth/*',
    methods: '*',
    budget: AUTH_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #65 — general auth surface; tighter per-endpoint limits overlay this',
  },
  {
    id: 'auth-login',
    route: '/v1/auth/login',
    methods: 'POST',
    budget: LOGIN_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #466 — tighter overlay on login to limit credential brute force',
  },
  {
    id: 'auth-register',
    route: '/v1/auth/register',
    methods: 'POST',
    budget: REGISTER_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #466 — tighter overlay on register to limit account farming',
  },
  {
    id: 'auth-forgot-password',
    route: '/v1/auth/password-reset/request',
    methods: 'POST',
    budget: FORGOT_PASSWORD_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #466 — tighter overlay to limit email enumeration and reset spam',
  },
  {
    id: 'auth-refresh',
    route: '/v1/auth/refresh',
    methods: 'POST',
    budget: REFRESH_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'domain-router',
    notes: 'Issue #240 — per-user sliding window keyed on SHA-256(JWT sub)',
  },
  {
    id: 'reservation-mutation',
    route: '/v1/reservations',
    methods: 'POST',
    budget: MUTATION_BUDGETS.reservation,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #613 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'reservation-cancel',
    route: '/v1/reservations/:id',
    methods: 'DELETE',
    budget: MUTATION_BUDGETS.reservation,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #613 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'profile-patch',
    route: '/v1/me',
    methods: 'PATCH',
    budget: MUTATION_BUDGETS.profile,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #613 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'consents-patch',
    route: '/v1/me/consents',
    methods: 'PATCH',
    budget: MUTATION_BUDGETS.profile,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #613 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'export-post',
    route: '/v1/members/me/export',
    methods: 'POST',
    budget: MUTATION_BUDGETS.export,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #613 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'coach-ask',
    route: '/v1/coach/ask',
    methods: 'POST',
    budget: MUTATION_BUDGETS.coach,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'domain-router',
    notes:
      'Epic 21 — burst limit on paid model calls, mounted in routes/coach.ts after jwtAuth and the ai-coach flag check (flag off → 404, no bucket touched); the daily quota (Redis counter, fail-closed) is enforced by the use case',
  },
  {
    id: 'session-post',
    route: '/v1/sessions',
    methods: 'POST',
    budget: MUTATION_BUDGETS.session,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'worker.ts',
    notes:
      'Issue #652 — jwtAuth pre-pass; 401 before the mutation bucket is touched; the global /v1 IP bucket still applies',
  },
  {
    id: 'classes-search',
    route: '/v1/classes/search',
    methods: 'GET',
    budget: EXPENSIVE_READ_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — gateway mount pre-jwtAuth → IP bucket; global /v1 user bucket when authed',
  },
  {
    id: 'members-list',
    route: '/v1/members',
    methods: 'GET',
    budget: MEMBERS_LIST_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — exact list path only (isMembersListGetPath)',
  },
  {
    id: 'audit-list',
    route: '/v1/audit',
    methods: 'GET',
    budget: EXPENSIVE_READ_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — gateway mount pre-jwtAuth → IP bucket',
  },
  {
    id: 'progression-read',
    route: '/v1/me/progression',
    methods: 'GET',
    budget: EXPENSIVE_READ_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes:
      'Issue #639 — aggregates up to a year of sessions; gateway mount pre-jwtAuth → IP bucket under its own rl:ip:progression namespace',
  },
  {
    id: 'admin-stats',
    route: '/admin/{dlq,outbox,jwt}/stats|state',
    methods: 'GET',
    budget: ADMIN_STATS_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — ops stats',
  },
  {
    id: 'studio-burst',
    route: '/v1/{members,classes,reservations,audit,...}/*',
    methods: '*',
    budget: 'studio-default',
    failPolicy: 'fail-open',
    bucket: 'studio',
    wiredIn: 'domain-router',
    notes: 'studioRateLimit() after jwtAuth — 1000/min/studio',
  },
  {
    id: 'checkin-post',
    route: '/v1/checkins',
    methods: 'POST',
    budget: CHECKIN_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'domain-router',
    notes:
      'Issue #654 — per kiosk operator (admin/coach only); one check-in per reservation is enforced by the single-use token and checkin_mark_reservation (#338)',
  },
  {
    id: 'checkin-token',
    route: '/v1/checkins/token',
    methods: 'POST',
    budget: CHECKIN_TOKEN_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'user',
    wiredIn: 'domain-router',
    notes: 'Issue #654 — QR token issuance, rotated every 120 s by the app',
  },
];

/** Explicit fail-closed rows — tests fail if an id is removed or policy regresses. */
export const REQUIRED_FAIL_CLOSED_IDS = [
  'auth',
  'auth-login',
  'auth-register',
  'auth-forgot-password',
  'auth-refresh',
  'reservation-mutation',
  'reservation-cancel',
  'profile-patch',
  'consents-patch',
  'export-post',
  'coach-ask',
  'session-post',
  'classes-search',
  'members-list',
  'audit-list',
  'progression-read',
  'admin-stats',
  'checkin-post',
  'checkin-token',
] as const;

/** Rows that must stay fail-closed (mutations + expensive reads + auth). */
export function rowsRequiringFailClosed(): RateLimitCoverageRow[] {
  return RATE_LIMIT_COVERAGE.filter(
    (r) =>
      (REQUIRED_FAIL_CLOSED_IDS as readonly string[]).includes(r.id) &&
      r.failPolicy === 'fail-closed',
  );
}

/** True when a GET list path should use the members-list limiter. */
export function isMembersListGetPath(pathname: string): boolean {
  const normalised = pathname.replace(/\/+$/, '') || '/';
  return normalised === '/v1/members';
}

/** True when a GET path is an admin stats probe. */
export function isAdminStatsGetPath(pathname: string): boolean {
  return (ADMIN_STATS_GET_PATHS as readonly string[]).includes(pathname);
}

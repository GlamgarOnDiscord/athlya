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

/** Expensive authenticated reads — fail-closed when Upstash is down. */
export const EXPENSIVE_READ_PATHS = [
  { path: '/v1/classes/search', match: 'prefix' as const },
  { path: '/v1/members', match: 'exact-get-list' as const },
  { path: '/v1/audit', match: 'prefix' as const },
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

export const AUTH_BUDGET: RateLimitBudget = { ipLimit: 20, windowSec: 60 };

export const MUTATION_BUDGETS = {
  reservation: { userLimit: 10, ipLimit: 10, windowSec: 60 },
  profile: { userLimit: 5, ipLimit: 5, windowSec: 60 },
  export: { userLimit: 1, ipLimit: 1, windowSec: 86400 },
} as const satisfies Record<string, RateLimitBudget>;

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
    failPolicy: 'fail-closed-soft',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes: 'Issue #128 — 429 synthetic if Redis down',
  },
  {
    id: 'auth',
    route: '/v1/auth/*',
    methods: '*',
    budget: AUTH_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip',
    wiredIn: 'worker.ts',
    notes: 'Issue #65',
  },
  {
    id: 'reservation-mutation',
    route: '/v1/reservations',
    methods: 'POST',
    budget: MUTATION_BUDGETS.reservation,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
  },
  {
    id: 'reservation-cancel',
    route: '/v1/reservations/:id',
    methods: 'DELETE',
    budget: MUTATION_BUDGETS.reservation,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
  },
  {
    id: 'profile-patch',
    route: '/v1/me',
    methods: 'PATCH',
    budget: MUTATION_BUDGETS.profile,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
  },
  {
    id: 'consents-patch',
    route: '/v1/me/consents',
    methods: 'PATCH',
    budget: MUTATION_BUDGETS.profile,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
  },
  {
    id: 'export-post',
    route: '/v1/members/me/export',
    methods: 'POST',
    budget: MUTATION_BUDGETS.export,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
  },
  {
    id: 'classes-search',
    route: '/v1/classes/search',
    methods: 'GET',
    budget: EXPENSIVE_READ_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — DB search',
  },
  {
    id: 'members-list',
    route: '/v1/members',
    methods: 'GET',
    budget: MEMBERS_LIST_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — enumeration surface (exact path, not /me)',
  },
  {
    id: 'audit-list',
    route: '/v1/audit',
    methods: 'GET',
    budget: EXPENSIVE_READ_BUDGET,
    failPolicy: 'fail-closed',
    bucket: 'ip+user',
    wiredIn: 'worker.ts',
    notes: 'Issue #133 — admin audit pagination',
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
];

/** Rows that must stay fail-closed (mutations + expensive reads + auth). */
export function rowsRequiringFailClosed(): RateLimitCoverageRow[] {
  return RATE_LIMIT_COVERAGE.filter((r) => r.failPolicy === 'fail-closed');
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

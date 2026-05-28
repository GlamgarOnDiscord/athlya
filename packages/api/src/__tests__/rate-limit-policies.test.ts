import { describe, expect, it } from 'vitest';

import {
  ADMIN_STATS_GET_PATHS,
  isAdminStatsGetPath,
  isMembersListGetPath,
  RATE_LIMIT_COVERAGE,
  rowsRequiringFailClosed,
} from '../middleware/rate-limit-policies.js';

describe('rate-limit-policies (#133)', () => {
  it('documents every wired row with a unique id', () => {
    const ids = RATE_LIMIT_COVERAGE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(rowsRequiringFailClosed().map((r) => [r.id, r.route] as const))(
    '%s (%s) uses fail-closed',
    (id) => {
      const row = RATE_LIMIT_COVERAGE.find((r) => r.id === id);
      expect(row?.failPolicy).toBe('fail-closed');
    },
  );

  it('global limiter uses fail-closed-soft', () => {
    const global = RATE_LIMIT_COVERAGE.find((r) => r.id === 'global-v1');
    expect(global?.failPolicy).toBe('fail-closed-soft');
  });

  it('expensive read rows are fail-closed', () => {
    for (const id of ['classes-search', 'members-list', 'audit-list', 'admin-stats']) {
      expect(RATE_LIMIT_COVERAGE.find((r) => r.id === id)?.failPolicy).toBe('fail-closed');
    }
  });

  it('isMembersListGetPath matches list root only', () => {
    expect(isMembersListGetPath('/v1/members')).toBe(true);
    expect(isMembersListGetPath('/v1/members/')).toBe(true);
    expect(isMembersListGetPath('/v1/members/me')).toBe(false);
    expect(isMembersListGetPath('/v1/members/me/export')).toBe(false);
  });

  it('isAdminStatsGetPath covers ops probes', () => {
    for (const path of ADMIN_STATS_GET_PATHS) {
      expect(isAdminStatsGetPath(path)).toBe(true);
    }
    expect(isAdminStatsGetPath('/admin/dlq/replay/x')).toBe(false);
  });
});

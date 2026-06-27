import { describe, expect, it } from 'vitest';

import {
  ADMIN_STATS_GET_PATHS,
  isAdminStatsGetPath,
  isMembersListGetPath,
  RATE_LIMIT_COVERAGE,
  REQUIRED_FAIL_CLOSED_IDS,
} from '../middleware/rate-limit-policies.js';

describe('rate-limit-policies (#133)', () => {
  it('documents every wired row with a unique id', () => {
    const ids = RATE_LIMIT_COVERAGE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([...REQUIRED_FAIL_CLOSED_IDS] as const)('%s remains fail-closed in registry', (id) => {
    const row = RATE_LIMIT_COVERAGE.find((r) => r.id === id);
    expect(row, `missing coverage row ${id}`).toBeDefined();
    expect(row?.failPolicy).toBe('fail-closed');
  });

  it('global limiter uses fail-open (issue #322)', () => {
    const global = RATE_LIMIT_COVERAGE.find((r) => r.id === 'global-v1');
    expect(global?.failPolicy).toBe('fail-open');
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

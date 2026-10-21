import { describe, expect, it } from 'vitest';

import { canOpenRoute, readsPlanningOnly } from './console-routes';

const CLASS = '/dashboard/classes/cccccccc-cccc-4ccc-8ccc-cccccccccc01';
const MEMBER_FILE = '/dashboard/members/11111111-1111-4111-8111-111111111111';

describe('canOpenRoute', () => {
  it('opens every page to an admin', () => {
    for (const path of [
      '/dashboard',
      '/dashboard/billing',
      '/dashboard/branding',
      '/dashboard/team',
      CLASS,
    ]) {
      expect(canOpenRoute('admin', path)).toBe(true);
    }
  });

  it('keeps a manager out of billing and branding only', () => {
    expect(canOpenRoute('manager', '/dashboard/classes')).toBe(true);
    expect(canOpenRoute('manager', '/dashboard/programs')).toBe(true);
    expect(canOpenRoute('manager', '/dashboard/team')).toBe(true);
    expect(canOpenRoute('manager', '/dashboard/audit')).toBe(true);
    expect(canOpenRoute('manager', MEMBER_FILE)).toBe(true);
    expect(canOpenRoute('manager', '/dashboard/billing')).toBe(false);
    expect(canOpenRoute('manager', '/dashboard/branding')).toBe(false);
    expect(canOpenRoute('manager', '/dashboard/planning')).toBe(false);
  });

  it('opens the front desk pages to the front desk', () => {
    for (const path of [
      '/dashboard',
      '/dashboard/planning',
      '/dashboard/members',
      MEMBER_FILE,
      '/dashboard/checkin',
      CLASS,
    ]) {
      expect(canOpenRoute('accueil', path)).toBe(true);
    }
    for (const path of [
      '/dashboard/classes',
      '/dashboard/programs',
      '/dashboard/team',
      '/dashboard/audit',
      '/dashboard/billing',
    ]) {
      expect(canOpenRoute('accueil', path)).toBe(false);
    }
  });

  it('opens a roster but no member file to a coach, and the home exactly', () => {
    expect(canOpenRoute('coach', CLASS)).toBe(true);
    expect(canOpenRoute('coach', '/dashboard/checkin/')).toBe(true);
    expect(canOpenRoute('coach', MEMBER_FILE)).toBe(false);
    expect(canOpenRoute('coach', '/dashboard/classes/c1/edit')).toBe(false);
    expect(canOpenRoute('coach', '/dashboard/checkins')).toBe(false);
    expect(canOpenRoute('coach', '/dashboard/planning-admin')).toBe(false);
  });

  it('opens nothing to a member', () => {
    expect(canOpenRoute('member', '/dashboard')).toBe(false);
    expect(canOpenRoute('member', '/dashboard/checkin')).toBe(false);
  });
});

describe('readsPlanningOnly', () => {
  it('holds for the coach and the front desk, not for the planners', () => {
    expect(readsPlanningOnly('coach')).toBe(true);
    expect(readsPlanningOnly('accueil')).toBe(true);
    expect(readsPlanningOnly('manager')).toBe(false);
    expect(readsPlanningOnly('admin')).toBe(false);
    expect(readsPlanningOnly('member')).toBe(false);
  });
});

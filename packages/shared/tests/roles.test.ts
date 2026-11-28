/**
 * The studio capability matrix (issue #756): what each role may do.
 */
import { describe, expect, it } from 'vitest';

import { ROLES, STAFF_ROLES, can, isRole, isStaffRole, rolesWith } from '../src/roles.js';
import { RoleSchema } from '../src/schemas/primitives.js';

import type { Capability, Role } from '../src/roles.js';

const EVERY: readonly Capability[] = [
  'console.access',
  'classes.write',
  'planning.read',
  'programs.write',
  'programs.readDrafts',
  'members.list',
  'members.file',
  'members.export',
  'roster.all',
  'roster.own',
  'checkin.kiosk',
  'audit.read',
  'team.read',
  'team.manage',
  'billing.manage',
  'branding.manage',
  'settings.manage',
  'webhooks.manage',
];

function capabilitiesOf(role: Role): Capability[] {
  return EVERY.filter((capability) => can(role, capability));
}

describe('capability matrix', () => {
  it('gives an admin every capability but the own-classes roster', () => {
    expect(capabilitiesOf('admin')).toEqual(EVERY.filter((c) => c !== 'roster.own'));
  });

  it('gives a manager what an admin has, but billing, branding, team changes, settings and webhooks', () => {
    const adminOnly = EVERY.filter((c) => can('admin', c) && !can('manager', c));
    expect(adminOnly).toEqual([
      'team.manage',
      'billing.manage',
      'branding.manage',
      'settings.manage',
      'webhooks.manage',
    ]);
  });

  it('gives the front desk the kiosk, every roster, members and the planning, read only', () => {
    expect(capabilitiesOf('accueil')).toEqual([
      'console.access',
      'planning.read',
      'members.list',
      'members.file',
      'roster.all',
      'checkin.kiosk',
    ]);
  });

  it('gives a coach the kiosk, the directory, drafts and their own rosters', () => {
    expect(capabilitiesOf('coach')).toEqual([
      'console.access',
      'programs.readDrafts',
      'members.list',
      'roster.own',
      'checkin.kiosk',
    ]);
  });

  it('gives a member and an unknown role nothing', () => {
    expect(capabilitiesOf('member')).toEqual([]);
    expect(can('owner', 'console.access')).toBe(false);
    expect(can(undefined, 'console.access')).toBe(false);
    expect(can(null, 'console.access')).toBe(false);
  });

  it('keeps the CSV export of the member list with admins and managers', () => {
    expect(rolesWith('members.export')).toEqual(['admin', 'manager']);
    expect(can('accueil', 'members.file')).toBe(true);
    expect(can('accueil', 'members.export')).toBe(false);
  });

  it('lists the holders of a capability', () => {
    expect(rolesWith('team.manage')).toEqual(['admin']);
    expect(rolesWith('settings.manage')).toEqual(['admin']);
    expect(rolesWith('webhooks.manage')).toEqual(['admin']);
    expect(rolesWith('console.access')).toEqual(STAFF_ROLES);
  });
});

describe('role narrowing', () => {
  it('matches the wire schema and the staff subset', () => {
    expect(RoleSchema.options).toEqual([...ROLES]);
    expect(ROLES.filter(isStaffRole)).toEqual(['coach', 'admin', 'manager', 'accueil']);
    expect(isRole('manager')).toBe(true);
    expect(isRole('owner')).toBe(false);
    expect(isStaffRole('member')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { initials, roleCounts, visibleMembers } from './members-view';

import type { StudioMember } from '../../../lib/api/members';

function member(displayName: string, role: StudioMember['role'], createdAt: string): StudioMember {
  return {
    id: displayName,
    email: `${displayName.toLowerCase().replaceAll(' ', '.')}@example.com`,
    displayName,
    role,
    avatarUrl: null,
    createdAt,
  };
}

const ITEMS = [
  member('Léa Fontaine', 'member', '2026-09-26T09:15:00.000Z'),
  member('Camille Durand', 'admin', '2026-09-02T09:15:00.000Z'),
  member('Inès Garnier', 'coach', '2026-09-08T09:15:00.000Z'),
  member('Hugo Lefèvre', 'member', '2026-09-05T09:15:00.000Z'),
];

describe('roleCounts', () => {
  it('counts the loaded rows per role', () => {
    expect(roleCounts(ITEMS)).toEqual({ all: 4, member: 2, coach: 1, admin: 1 });
  });
});

describe('visibleMembers', () => {
  it('filters by role tab and accent-insensitive search', () => {
    expect(visibleMembers(ITEMS, 'member', '', 'name', 'fr').map((m) => m.displayName)).toEqual([
      'Hugo Lefèvre',
      'Léa Fontaine',
    ]);
    expect(visibleMembers(ITEMS, 'all', 'ines', 'name', 'fr')).toHaveLength(1);
  });

  it('sorts by join date both ways', () => {
    expect(visibleMembers(ITEMS, 'all', '', 'joinedDesc', 'fr')[0]?.displayName).toBe(
      'Léa Fontaine',
    );
    expect(visibleMembers(ITEMS, 'all', '', 'joinedAsc', 'fr')[0]?.displayName).toBe(
      'Camille Durand',
    );
  });
});

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Léa Rousseau-Vandenberghe')).toBe('LR');
    expect(initials('Jean Paul Sartre')).toBe('JS');
    expect(initials('Camille')).toBe('C');
    expect(initials('  ')).toBe('?');
  });
});

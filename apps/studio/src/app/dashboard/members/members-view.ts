/**
 * Client-side views over the members already loaded from `GET /v1/members`:
 * role tabs, search, sort and the CSV export. Counts describe the loaded
 * rows only, since the endpoint returns no total.
 */
import { matchesQuery } from '../../../lib/search-text';

import type { StudioMember } from '../../../lib/api/members';

export type RoleTab = 'all' | StudioMember['role'];
export const ROLE_TABS: ReadonlyArray<RoleTab> = [
  'all',
  'member',
  'coach',
  'accueil',
  'manager',
  'admin',
];

export type MemberSort = 'name' | 'joinedDesc' | 'joinedAsc';

export function roleCounts(items: ReadonlyArray<StudioMember>): Record<RoleTab, number> {
  const counts: Record<RoleTab, number> = {
    all: items.length,
    member: 0,
    coach: 0,
    accueil: 0,
    manager: 0,
    admin: 0,
  };
  for (const m of items) counts[m.role] += 1;
  return counts;
}

export function visibleMembers(
  items: ReadonlyArray<StudioMember>,
  tab: RoleTab,
  query: string,
  sort: MemberSort,
  locale: string,
): StudioMember[] {
  const rows = items.filter(
    (m) => (tab === 'all' || m.role === tab) && matchesQuery(query, m.displayName, m.email),
  );
  if (sort === 'name') {
    return rows.sort((a, b) => a.displayName.localeCompare(b.displayName, locale));
  }
  const direction = sort === 'joinedDesc' ? -1 : 1;
  return rows.sort((a, b) => direction * a.createdAt.localeCompare(b.createdAt));
}

/** Two-letter initials of a display name, `?` when it has none. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0]];
  return letters.map((p) => p?.charAt(0).toUpperCase() ?? '').join('') || '?';
}

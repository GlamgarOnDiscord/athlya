/**
 * Console paths of a class roster and of a member file (issue #746), so
 * every entry point (planning tiles, today timeline, coach home, members
 * list) links to the same place.
 */

/** Detail of a class with its roster: studio admins and the class coach. */
export function classRosterHref(classId: string): string {
  return `/dashboard/classes/${encodeURIComponent(classId)}`;
}

/** Member file: studio admins only. */
export function memberFileHref(memberId: string): string {
  return `/dashboard/members/${encodeURIComponent(memberId)}`;
}

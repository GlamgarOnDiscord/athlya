/**
 * Which console page each role may open (issue #756), read from the
 * capability matrix of `@athlya/shared/roles`. A UX gate only: every page
 * reads endpoints that check the same capability, so a role that reached a
 * page it may not open would still get 403s from the API.
 */
import { can, type Role } from '@athlya/shared/roles';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLASS_DETAIL = new RegExp(`^/dashboard/classes/${UUID}/?$`, 'iu');
const MEMBER_FILE = new RegExp(`^/dashboard/members/${UUID}/?$`, 'iu');

/** The console home, where a staff role is sent from a page it may not open. */
export const CONSOLE_HOME = '/dashboard';

/** A role edits the planning, or reads it on the read-only schedule page. */
export function readsPlanningOnly(role: Role): boolean {
  return can(role, 'console.access') && !can(role, 'classes.write');
}

function under(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Whether `role` may open the console page at `pathname`. */
export function canOpenRoute(role: Role, pathname: string): boolean {
  if (!can(role, 'console.access')) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/$/u, '') : pathname;

  if (path === CONSOLE_HOME) return true;
  if (CLASS_DETAIL.test(path)) return can(role, 'roster.all') || can(role, 'roster.own');
  if (path === '/dashboard/classes') return can(role, 'classes.write');
  if (under(path, '/dashboard/planning')) return readsPlanningOnly(role);
  if (MEMBER_FILE.test(path)) return can(role, 'members.file');
  if (path === '/dashboard/members') return can(role, 'members.list');
  if (under(path, '/dashboard/checkin')) return can(role, 'checkin.kiosk');
  if (under(path, '/dashboard/programs')) return can(role, 'programs.write');
  if (under(path, '/dashboard/team')) return can(role, 'team.read');
  if (under(path, '/dashboard/audit')) return can(role, 'audit.read');
  if (under(path, '/dashboard/branding')) return can(role, 'branding.manage');
  if (under(path, '/dashboard/billing')) return can(role, 'billing.manage');
  // A page this table does not know stays with the studio owner.
  return role === 'admin';
}

/**
 * Client-side admin gate.
 *
 * Wraps every page below `/dashboard`. Redirects to `/login` when no
 * token is present, and to `/forbidden` when the user is signed in
 * but lacks the `admin` role. The server-side gate is the
 * authoritative one (`requireRole('admin')` in the API gateway, which
 * returns 403 with a Problem Details body); this client gate is
 * purely a UX shortcut so non-admins see a friendly screen instead
 * of a flash of admin UI followed by a flood of 403s.
 *
 * Why two gates?
 *   - Server gate is enforced on every API call, period — defence in
 *     depth. A malicious user who replaces this component cannot
 *     reach studio data.
 *   - Client gate avoids rendering the admin shell for a
 *     `member`/`coach` user who lands on `/dashboard` after an
 *     accidental navigation, and avoids the FOUC of admin UI
 *     showing for a few hundred ms before the API rejects the page.
 *
 * Coaches are let through on {@link COACH_ROUTES} only: their home, their
 * read-only schedule, the members directory, the check-in kiosk and the
 * roster of a class, all backed by endpoints the API opens to the `coach`
 * role (`GET /v1/classes`, `GET /v1/members`, `POST /v1/checkins`,
 * `GET /v1/classes/:id/roster` for the classes they coach). A member file
 * (`/dashboard/members/:id`) stays admin only, like `GET /v1/members/:id`.
 * A coach landing anywhere else under `/dashboard` is sent to their home.
 *
 * @see Requirements 6.5 (admin-only routes), 14.1 (auth chain).
 */
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactElement, type ReactNode } from 'react';

import { useAuth } from '../lib/auth/AuthContext';
import { navigateTo } from '../lib/full-reload';

/** The console landing: the coach home for a coach. Matched exactly, never as a prefix. */
const DASHBOARD_HOME = '/dashboard';

/**
 * Dashboard routes a coach may open, home first (where a coach is sent
 * from any other route). Every other route is admin-only.
 */
export const COACH_ROUTES: readonly string[] = [
  DASHBOARD_HOME,
  '/dashboard/planning',
  '/dashboard/members',
  '/dashboard/checkin',
];

/** Coach routes matched exactly: the pages below them are admin only. */
const EXACT_COACH_ROUTES: ReadonlySet<string> = new Set([DASHBOARD_HOME, '/dashboard/members']);

/** A class detail page, `/dashboard/classes/<id>`; the classes list itself is admin only. */
const CLASS_DETAIL =
  /^\/dashboard\/classes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/iu;

/**
 * True when `pathname` is one of {@link COACH_ROUTES} (the home and the
 * members directory exactly, the others with their sub-paths) or a class
 * detail page.
 */
export function isCoachRoute(pathname: string): boolean {
  if (CLASS_DETAIL.test(pathname)) return true;
  return COACH_ROUTES.some(
    (route) =>
      pathname === route || (!EXACT_COACH_ROUTES.has(route) && pathname.startsWith(`${route}/`)),
  );
}

export interface RequireAdminProps {
  readonly children: ReactNode;
}

export function RequireAdmin({ children }: RequireAdminProps): ReactElement | null {
  const { push } = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isAdmin, user, bootResolved } = useAuth();
  const isCoach = user?.role === 'coach';
  const allowed = isAdmin || (isCoach && isCoachRoute(pathname));

  useEffect(() => {
    // Wait for the boot silent-refresh to resolve before
    // deciding to redirect — otherwise a hard refresh of
    // /dashboard always bounces to /login during the ~200-500 ms
    // the refresh fetch takes, even when the cookie is valid.
    if (!bootResolved) return;
    // Leaving or entering the kiosk loads a new document so each page keeps
    // its own camera policy (`lib/full-reload.ts`).
    if (!isAuthenticated) {
      navigateTo('/login', push, pathname);
      return;
    }
    // `user` is null for a brief tick on the very first render
    // after `setAccessToken(...)` lands but before `setUser(...)`
    // — guard against premature redirect to `/forbidden` during
    // that tick.
    if (user !== null && !allowed) {
      navigateTo(isCoach ? (COACH_ROUTES[0] ?? '/forbidden') : '/forbidden', push, pathname);
    }
  }, [bootResolved, isAuthenticated, allowed, isCoach, user, push, pathname]);

  if (!bootResolved) return null;
  if (!isAuthenticated) return null;
  if (user !== null && !allowed) return null;

  return <>{children}</>;
}

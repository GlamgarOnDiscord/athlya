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
 * Coaches are let through on {@link COACH_ROUTES} only: the check-in
 * kiosk, which the API opens to the `coach` role too. A coach landing
 * anywhere else under `/dashboard` is sent to the kiosk.
 *
 * @see Requirements 6.5 (admin-only routes), 14.1 (auth chain).
 */
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactElement, type ReactNode } from 'react';

import { useAuth } from '../lib/auth/AuthContext';

/** Dashboard routes a coach may open. Every other route is admin-only. */
export const COACH_ROUTES: readonly string[] = ['/dashboard/checkin'];

/** True when `pathname` is one of {@link COACH_ROUTES} or below it. */
export function isCoachRoute(pathname: string): boolean {
  return COACH_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
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
    if (!isAuthenticated) {
      push('/login');
      return;
    }
    // `user` is null for a brief tick on the very first render
    // after `setAccessToken(...)` lands but before `setUser(...)`
    // — guard against premature redirect to `/forbidden` during
    // that tick.
    if (user !== null && !allowed) {
      push(isCoach ? (COACH_ROUTES[0] ?? '/forbidden') : '/forbidden');
    }
  }, [bootResolved, isAuthenticated, allowed, isCoach, user, push]);

  if (!bootResolved) return null;
  if (!isAuthenticated) return null;
  if (user !== null && !allowed) return null;

  return <>{children}</>;
}

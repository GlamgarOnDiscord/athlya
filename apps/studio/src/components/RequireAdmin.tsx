/**
 * Client-side console gate.
 *
 * Wraps every page below `/dashboard`. Redirects to `/login` when no
 * token is present, and away from a page the signed-in role may not
 * open. The server-side gate is the authoritative one
 * (`requireCapability(...)` in the API gateway, which returns 403 with
 * a Problem Details body); this client gate is purely a UX shortcut so
 * a role sees a friendly screen instead of a flash of UI followed by a
 * flood of 403s.
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
 * Each role is let through on the pages {@link canOpenRoute} opens to it,
 * from the capability matrix of `@athlya/shared/roles` (issue #756): a
 * manager everywhere but billing and branding, the front desk on the
 * kiosk, the planning, the members and their files and the class
 * rosters, a coach on their home, their schedule, the members directory,
 * the kiosk and the roster of the classes they coach. A staff role
 * landing on another page is sent to the console home; a member to
 * `/forbidden`.
 *
 * @see Requirements 6.5 (admin-only routes), 14.1 (auth chain).
 */
'use client';

import { can } from '@athlya/shared/roles';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactElement, type ReactNode } from 'react';

import { useAuth } from '../lib/auth/AuthContext';
import { CONSOLE_HOME, canOpenRoute } from '../lib/auth/console-routes';
import { navigateTo } from '../lib/full-reload';

export interface RequireAdminProps {
  readonly children: ReactNode;
}

export function RequireAdmin({ children }: RequireAdminProps): ReactElement | null {
  const { push } = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, user, bootResolved } = useAuth();
  const isStaff = user !== null && can(user.role, 'console.access');
  const allowed = user !== null && canOpenRoute(user.role, pathname);

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
      navigateTo(isStaff ? CONSOLE_HOME : '/forbidden', push, pathname);
    }
  }, [bootResolved, isAuthenticated, allowed, isStaff, user, push, pathname]);

  if (!bootResolved) return null;
  if (!isAuthenticated) return null;
  if (user !== null && !allowed) return null;

  return <>{children}</>;
}

/**
 * Client-side auth guard for protected pages.
 *
 * Reads the in-memory access token through `useAuth()`. When the
 * effect runs after hydration and the token is still absent,
 * navigates to `/login` via the Next router. While the redirect is
 * in flight, we render `null` so protected content never flashes to
 * an unauthenticated viewer (FOUC-style leak).
 *
 * Why a client wrapper rather than a server-side redirect?
 *   - The access token lives in JavaScript memory (`token-store.ts`),
 *     not in a cookie, so the server cannot read it during the initial
 *     render. The only source of truth on "am I authenticated?" lives
 *     in the browser, which means the gate must run after hydration.
 *   - Keeping the wrapper dumb (no data fetching, no session ping)
 *     also makes it trivially testable and keeps protected pages
 *     free of boilerplate.
 *
 * Layering rationale: sits under `src/components/` rather than
 * `src/lib/auth/` because it is a pure UI concern (renders a React
 * subtree), while `lib/auth/` holds the non-React infrastructure
 * (token store, context, cookies).
 *
 * @see Requirements 3.1, 3.2, 14.1.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactElement, type ReactNode } from 'react';

import { useAuth } from '../lib/auth/AuthContext';

export interface RequireAuthProps {
  readonly children: ReactNode;
}

/**
 * Wrap a client subtree that must only render for authenticated
 * users. Unauthenticated visitors are redirected to `/login`.
 */
export function RequireAuth({ children }: RequireAuthProps): ReactElement | null {
  const { push } = useRouter();
  const { isAuthenticated, bootResolved } = useAuth();

  useEffect(() => {
    // Wait for the boot silent-refresh to resolve before
    // deciding to redirect — see `apps/studio/.../RequireAdmin.tsx`
    // for the matching rationale.
    if (!bootResolved) return;
    if (!isAuthenticated) {
      push('/login');
    }
  }, [bootResolved, isAuthenticated, push]);

  if (!bootResolved) {
    return null;
  }
  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

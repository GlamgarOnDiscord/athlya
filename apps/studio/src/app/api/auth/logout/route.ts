/**
 * `POST /api/auth/logout` — studio admin copy.
 *
 * Same as `apps/web/src/app/api/auth/logout/route.ts` but clears the
 * studio-scoped refresh cookie (`athlya.refresh.studio`).
 *
 * @see Requirements 1.5, 2.3.
 */
import { NextResponse } from 'next/server';

import { REFRESH_COOKIE_NAME, buildClearRefreshCookie } from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl, isSecureCookieEnv } from '../../../../lib/env';

import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = assertSameOrigin(request);
  if (denied !== null) return denied;

  const isProduction = isSecureCookieEnv();
  const authHeader = request.headers.get('authorization');
  if (authHeader !== null && authHeader !== '') {
    const apiUrl = getPublicApiUrl();
    const target = `${apiUrl}/v1/auth/logout`;
    const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    try {
      await fetch(target, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
        // The refresh token names the one session to revoke; the user's
        // other devices stay signed in (audit finding S2-010).
        ...(refreshToken !== undefined && refreshToken !== ''
          ? { body: JSON.stringify({ refreshToken }) }
          : {}),
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      });
    } catch {
      // Best-effort upstream logout — local session always clears.
    }
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'set-cookie': buildClearRefreshCookie(isProduction),
    },
  });
}

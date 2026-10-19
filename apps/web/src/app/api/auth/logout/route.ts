/**
 * `POST /api/auth/logout`.
 *
 *  1. Clear the `athlya.refresh` cookie — the most important step;
 *     works even if the upstream is unreachable.
 *  2. If the request carried an `Authorization` header, forward the
 *     logout to the upstream API with the refresh cookie's token so
 *     the server revokes this session only. Best-effort — failures
 *     are swallowed.
 *  3. Return 204 No Content.
 *
 * @see Requirements 1.5, 2.3.
 */
import { NextResponse } from 'next/server';

import { REFRESH_COOKIE_NAME, buildClearRefreshCookie } from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl, isSecureCookieEnv } from '../../../../lib/env';

import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Sprint-3 SP3.1 (S4-005 + S6-005) — same-origin guard.
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
      // Best-effort — a failed upstream logout is logged upstream
      // via its middleware, but the client-side logout must still
      // succeed so the user's session cannot linger on this device.
    }
  }

  return new NextResponse(null, {
    status: 204,
    headers: {
      'set-cookie': buildClearRefreshCookie(isProduction),
    },
  });
}

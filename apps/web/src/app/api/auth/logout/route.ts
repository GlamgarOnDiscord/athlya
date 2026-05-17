/**
 * `POST /api/auth/logout`.
 *
 *  1. Clear the `athlya.refresh` cookie — the most important step;
 *     works even if the upstream is unreachable.
 *  2. If the request carried an `Authorization` header, forward the
 *     logout to the upstream API so the server can invalidate the
 *     refresh token family. Best-effort — failures are swallowed.
 *  3. Return 204 No Content.
 *
 * @see Requirements 1.5, 2.3.
 */
import { NextResponse } from 'next/server';

import { buildClearRefreshCookie } from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl } from '../../../../lib/env';

import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Sprint-3 SP3.1 (S4-005 + S6-005) — same-origin guard.
  const denied = assertSameOrigin(request);
  if (denied !== null) return denied;

  const isProduction = process.env['NODE_ENV'] === 'production';
  const authHeader = request.headers.get('authorization');
  if (authHeader !== null && authHeader !== '') {
    const apiUrl = getPublicApiUrl();
    const target = `${apiUrl}/v1/auth/logout`;
    try {
      await fetch(target, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
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

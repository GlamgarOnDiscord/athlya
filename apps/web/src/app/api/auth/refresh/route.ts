/**
 * `POST /api/auth/refresh` — exchange the httpOnly refresh cookie for
 * a fresh access token + a rotated refresh token.
 *
 *  1. Read the `athlya.refresh` cookie. Absent → 401 + clear (already
 *     gone, but we emit the clear header for safety).
 *  2. POST `{ refreshToken }` to `${API_URL}/v1/auth/refresh`.
 *  3. On success, write the new refresh token back into the cookie
 *     (rotation). Strip it from the JSON body.
 *  4. On failure, clear the cookie and return 401 Problem Details so
 *     the browser's `AuthContext` can drop to the signed-out state.
 *
 * @see Requirements 2.2, 2.3.
 */
import { NextResponse } from 'next/server';

import {
  REFRESH_COOKIE_NAME,
  buildClearRefreshCookie,
  buildRefreshCookie,
} from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl, isSecureCookieEnv } from '../../../../lib/env';

import type { ProblemDetails } from '@athlya/shared/schemas';
import type { NextRequest } from 'next/server';

interface UpstreamSessionResponse {
  readonly user: unknown;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresIn: number;
}

interface ClientSessionResponse {
  readonly user: unknown;
  readonly accessToken: string;
  readonly accessTokenExpiresIn: number;
}

function problemJson(
  status: number,
  partial: Omit<ProblemDetails, 'status'>,
  extraHeaders: HeadersInit = {},
): NextResponse {
  const body: ProblemDetails = { ...partial, status };
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/problem+json');
  return new NextResponse(JSON.stringify(body), { status, headers });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Sprint-3 SP3.1 (S4-005 + S6-005) — same-origin guard.
  const denied = assertSameOrigin(request);
  if (denied !== null) return denied;

  const isProduction = isSecureCookieEnv();
  const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
  if (refreshToken === undefined || refreshToken === '') {
    return problemJson(
      401,
      {
        type: 'about:blank',
        title: 'Missing refresh token',
        code: 'missing_refresh_token',
      },
      { 'set-cookie': buildClearRefreshCookie(isProduction) },
    );
  }

  const apiUrl = getPublicApiUrl();
  const target = `${apiUrl}/v1/auth/refresh`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    return problemJson(502, {
      type: 'about:blank',
      title: 'Upstream unreachable',
      code: 'upstream_unreachable',
    });
  }

  if (!upstream.ok) {
    return problemJson(
      401,
      {
        type: 'about:blank',
        title: 'Refresh failed',
        code: 'refresh_failed',
      },
      { 'set-cookie': buildClearRefreshCookie(isProduction) },
    );
  }

  let session: UpstreamSessionResponse;
  try {
    session = (await upstream.json()) as UpstreamSessionResponse;
  } catch {
    return problemJson(502, {
      type: 'about:blank',
      title: 'Malformed upstream response',
      code: 'upstream_malformed',
    });
  }

  const client: ClientSessionResponse = {
    user: session.user,
    accessToken: session.accessToken,
    accessTokenExpiresIn: session.accessTokenExpiresIn,
  };

  return new NextResponse(JSON.stringify(client), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': buildRefreshCookie({
        token: session.refreshToken,
        maxAgeSec: session.refreshTokenExpiresIn,
        isProduction,
      }),
    },
  });
}

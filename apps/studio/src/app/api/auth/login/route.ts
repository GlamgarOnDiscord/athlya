/**
 * `POST /api/auth/login` — server-side proxy for the studio admin app.
 *
 * Mirrors `apps/web/src/app/api/auth/login/route.ts`. The only
 * differences are the refresh-cookie name (`athlya.refresh.studio`
 * here, see `lib/auth/cookies.ts`) and the lack of role gate at this
 * layer — admin/non-admin users both authenticate through the same
 * `/v1/auth/login` upstream; the role check happens later when the
 * client navigates to `/dashboard` (`<RequireAdmin>` + API gateway
 * `requireRole('admin')`).
 *
 * Returning a non-admin role is intentionally allowed here: the user
 * sees a `/forbidden` screen rather than a confusing 401.
 *
 * @see Requirements 1.5, 2.3, 26.1, 26.2.
 */

import { LoginRequestSchema } from '@athlya/shared/schemas/api';
import { NextResponse } from 'next/server';

import { buildRefreshCookie } from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl } from '../../../../lib/env';

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

function problemJson(status: number, partial: Omit<ProblemDetails, 'status'>): NextResponse {
  const body: ProblemDetails = { ...partial, status };
  return NextResponse.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = assertSameOrigin(request);
  if (denied !== null) return denied;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return problemJson(400, {
      type: 'about:blank',
      title: 'Invalid JSON body',
      code: 'invalid_json',
    });
  }

  const parsed = LoginRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return problemJson(422, {
      type: 'about:blank',
      title: 'Validation failed',
      code: 'validation_failed',
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const turnstileToken = request.headers.get('cf-turnstile-token') ?? '';
  const apiUrl = getPublicApiUrl();
  const target = `${apiUrl}/v1/auth/login`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-turnstile-token': turnstileToken,
      },
      body: JSON.stringify(parsed.data),
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

  const contentType = upstream.headers.get('content-type') ?? '';
  const bodyText = await upstream.text();

  if (!upstream.ok) {
    return new NextResponse(bodyText, {
      status: upstream.status,
      headers: {
        'content-type': contentType !== '' ? contentType : 'application/json',
      },
    });
  }

  let session: UpstreamSessionResponse;
  try {
    session = JSON.parse(bodyText) as UpstreamSessionResponse;
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

  const cookie = buildRefreshCookie({
    token: session.refreshToken,
    maxAgeSec: session.refreshTokenExpiresIn,
    isProduction: process.env['APP_ENV'] === 'production',
  });

  return new NextResponse(JSON.stringify(client), {
    status: upstream.status,
    headers: {
      'content-type': 'application/json',
      'set-cookie': cookie,
    },
  });
}

/**
 * `POST /api/auth/register` — server-side proxy to the Hono API.
 *
 * Responsibilities
 * ----------------
 *  1. Zod-validate the incoming body against the shared
 *     `RegisterRequestSchema`. A malformed body returns `422 Problem
 *     Details` *without* hitting the upstream API.
 *  2. Forward to `${API_URL}/v1/auth/register` with the
 *     `cf-turnstile-token` header propagated from the browser
 *     request — the gateway Turnstile middleware validates it.
 *  3. On upstream 2xx, strip the `refreshToken` field from the JSON
 *     body (the browser never touches it) and place it in the
 *     `athlya.refresh` httpOnly cookie, attributes per
 *     `buildRefreshCookie`.
 *  4. On upstream non-2xx, forward the body + status verbatim so the
 *     client can render the Problem Details it already knows how to
 *     parse.
 *
 * @see Requirements 1.1, 1.2, 2.3, 26.1, 26.2.
 */

import { RegisterRequestSchema } from '@athlya/shared/schemas/api';
import { NextResponse } from 'next/server';

import { buildRefreshCookie } from '../../../../lib/auth/cookies';
import { assertSameOrigin } from '../../../../lib/auth/same-origin';
import { getPublicApiUrl } from '../../../../lib/env';

import type { ProblemDetails } from '@athlya/shared/schemas';
import type { NextRequest } from 'next/server';

/** Shape the upstream API returns on success. */
interface UpstreamSessionResponse {
  readonly user: unknown;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresIn: number;
}

/** Shape exposed to the browser (refresh token stripped). */
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

  const parsed = RegisterRequestSchema.safeParse(rawBody);
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

  // The Turnstile token may be missing — we forward an empty string
  // so the gateway Turnstile middleware rejects with `403
  // bot_challenge_failed` (Req 26.3) rather than us second-guessing.
  const turnstileToken = request.headers.get('cf-turnstile-token') ?? '';

  const apiUrl = getPublicApiUrl();
  const target = `${apiUrl}/v1/auth/register`;

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
    // Forward the body + status verbatim, preserving the content
    // type so the caller can parse Problem Details cleanly.
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

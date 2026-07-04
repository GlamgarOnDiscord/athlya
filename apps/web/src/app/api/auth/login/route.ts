/**
 * `POST /api/auth/login` — server-side proxy to the Hono API.
 *
 * Mirrors the register route exactly, differing only in the schema
 * and upstream path. See `register/route.ts` for the full rationale
 * on Turnstile propagation, cookie setup and error forwarding.
 *
 * @see Requirements 1.5, 2.3, 26.1, 26.2.
 */

import { LoginRequestSchema } from '@athlya/shared/schemas/api';
import { NextResponse } from 'next/server';

import { buildRefreshCookie } from '../../../../lib/auth/cookies';
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

function problemJson(status: number, partial: Omit<ProblemDetails, 'status'>): NextResponse {
  const body: ProblemDetails = { ...partial, status };
  return NextResponse.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Sprint-3 SP3.1 (Vague 31, audit findings S4-005 + S6-005) —
  // same-origin guard before ANY business logic. Defence in
  // depth on top of `SameSite=Lax` cookies; closes the
  // same-site-attacker gap (rogue subdomain, compromised tenant
  // page).
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
    isProduction: isSecureCookieEnv(),
  });

  return new NextResponse(JSON.stringify(client), {
    status: upstream.status,
    headers: {
      'content-type': 'application/json',
      'set-cookie': cookie,
    },
  });
}

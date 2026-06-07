/**
 * `POST /api/auth/password-reset/request` — Sprint 8 / SP7.5
 * (Vague 36) — Next.js proxy to the Hono API.
 *
 * Pattern identique à `/api/auth/login` : same-origin guard,
 * validation JSON, forward Turnstile token, propagation status +
 * body upstream.
 *
 * **Email-enumeration defence** : la route Hono renvoie 204 quel
 * que soit le résultat. Ce proxy se contente de transférer.
 *
 * @see Requirements S2-006, audit-S2-auth.md
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertSameOrigin } from '../../../../../lib/auth/same-origin';
import { getPublicApiUrl } from '../../../../../lib/env';

import type { NextRequest } from 'next/server';

const RequestBodySchema = z.strictObject({ email: z.email().max(254) });

function problemJson(
  status: number,
  body: { type: string; title: string; code: string },
): NextResponse {
  return NextResponse.json(
    { ...body, status },
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
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

  const parsed = RequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return problemJson(422, {
      type: 'about:blank',
      title: 'Validation failed',
      code: 'validation_failed',
    });
  }

  const turnstileToken = request.headers.get('cf-turnstile-token') ?? '';
  const apiUrl = getPublicApiUrl();
  const target = `${apiUrl}/v1/auth/password-reset/request`;

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-turnstile-token': turnstileToken,
      },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    // Forward upstream status verbatim — 204 on success, 4xx /
    // 5xx on rejections. Don't attempt to read the body when
    // status is 204 (it has none).
    if (upstream.status === 204) {
      return new NextResponse(null, { status: 204 });
    }
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/problem+json',
      },
    });
  } catch {
    return problemJson(502, {
      type: 'about:blank',
      title: 'Upstream unreachable',
      code: 'upstream_error',
    });
  }
}

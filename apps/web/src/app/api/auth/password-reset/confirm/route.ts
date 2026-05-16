/**
 * `POST /api/auth/password-reset/confirm` — Sprint 8 / SP7.5
 * (Vague 36) — Next.js proxy to the Hono API.
 *
 * Mirror exact de `request/route.ts`, sauf le path upstream et le
 * schema body. La logique de gestion d'erreur (token_invalid,
 * token_expired, password_breached, hibp_unavailable) est laissée
 * au client `<ResetPasswordForm />` qui mappe les codes en
 * messages utilisateur.
 *
 * @see packages/auth/src/forgot-password.ts
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertSameOrigin } from '../../../../../lib/auth/same-origin';
import { getPublicApiUrl } from '../../../../../lib/env';

import type { NextRequest } from 'next/server';

const ConfirmBodySchema = z
    .object({
        token: z.string().min(1).max(256),
        newPassword: z.string().min(8).max(72),
    })
    .strict();

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

    const parsed = ConfirmBodySchema.safeParse(rawBody);
    if (!parsed.success) {
        return problemJson(422, {
            type: 'about:blank',
            title: 'Validation failed',
            code: 'validation_failed',
        });
    }

    const turnstileToken = request.headers.get('cf-turnstile-token') ?? '';
    const apiUrl = getPublicApiUrl();
    const target = `${apiUrl}/v1/auth/password-reset/confirm`;

    try {
        const upstream = await fetch(target, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'cf-turnstile-token': turnstileToken,
            },
            body: JSON.stringify(parsed.data),
        });
        if (upstream.status === 204) {
            return new NextResponse(null, { status: 204 });
        }
        const body = await upstream.text();
        return new NextResponse(body, {
            status: upstream.status,
            headers: {
                'content-type':
                    upstream.headers.get('content-type') ??
                    'application/problem+json',
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

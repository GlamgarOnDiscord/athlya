/**
 * Same-origin guard for the studio `/api/auth/*` route handlers.
 *
 * Mirrors `apps/web/src/lib/auth/same-origin.ts` exactly.
 * Defence-in-depth on top of `SameSite=Lax` cookies — closes the
 * same-site attacker gap (rogue subdomain, compromised tenant page).
 *
 * @see docs/security/audit-S4-network.md S4-005
 * @see docs/security/audit-S6-frontend.md S6-005
 */

import { NextResponse } from 'next/server';

import type { NextRequest } from 'next/server';

interface ProblemBody {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly code: string;
}

function problemJson(status: number, body: ProblemBody): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

/**
 * Verify the request originates from the same origin as the
 * deployed studio app. Returns `null` on accept, a rejection
 * `NextResponse` on deny.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
    const expected = request.nextUrl.origin;
    const origin = request.headers.get('origin');

    if (origin === null || origin.length === 0) {
        return problemJson(403, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            code: 'cross_site_request',
        });
    }
    if (origin !== expected) {
        return problemJson(403, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            code: 'cross_site_request',
        });
    }

    const referer = request.headers.get('referer');
    if (referer !== null && referer.length > 0) {
        let refererOrigin: string | null = null;
        try {
            refererOrigin = new URL(referer).origin;
        } catch {
            // Malformed referer — deny.
        }
        if (refererOrigin !== expected) {
            return problemJson(403, {
                type: 'about:blank',
                title: 'Forbidden',
                status: 403,
                code: 'cross_site_request',
            });
        }
    }

    return null;
}

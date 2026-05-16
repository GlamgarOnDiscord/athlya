/**
 * Same-origin guard for the Next.js `/api/auth/*` route handlers.
 *
 * Sprint-3 Slice 3.1 (Vague 31, audit findings S4-005 + S6-005) —
 * defence-in-depth on top of `SameSite=Lax` cookies. The cookie
 * attribute already prevents a cross-site form-POST from carrying
 * the refresh token, but a same-site attacker (rogue subdomain,
 * compromised tenant page, evil HTML imported into a shared
 * support tool) can still bypass that. Validating that the
 * inbound request's `Origin` header matches the deployed app's
 * origin closes that gap.
 *
 * Policy
 * ------
 *   • Same-origin requests (browser-initiated, the normal case) →
 *     `Origin` header matches `request.nextUrl.origin` exactly →
 *     allow.
 *   • Missing `Origin` header → fail-closed. Modern browsers attach
 *     `Origin` on every cross-origin AND every same-origin
 *     mutation (POST / PATCH / DELETE) since 2020. The only
 *     legitimate callers without an `Origin` are server-to-server
 *     scripts (curl, fetch from another Worker) which have no
 *     business hitting `/api/auth/*` — that surface is browser-only.
 *   • Mismatch → fail-closed.
 *
 * The `Referer` header is ALSO checked when present. The two are
 * historically asymmetric: `Origin` covers POST/PATCH/DELETE,
 * `Referer` is sent on a wider set of requests. When both are
 * present and disagree, we deny — that pattern is the canonical
 * indicator of an in-flight CSRF.
 *
 * Returns `null` on success and a `Response` to be returned by the
 * route handler on failure. Keeping the rejection inline lets each
 * handler call this in two lines without duplicating the Problem
 * Details envelope.
 *
 * @see docs/security/audit-S6-frontend.md S6-005
 * @see docs/security/audit-S4-network.md S4-005
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
 * deployed app. Intended use:
 *
 * ```ts
 * export async function POST(request: NextRequest) {
 *     const denied = assertSameOrigin(request);
 *     if (denied !== null) return denied;
 *     // ... rest of handler
 * }
 * ```
 *
 * Returns `null` on accept, the rejection `NextResponse` on deny.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
    const expected = request.nextUrl.origin;
    const origin = request.headers.get('origin');

    // Missing Origin on a state-changing route is a CSRF tell.
    // Modern browsers always attach it on POST/PATCH/DELETE; an
    // absent header means the request was hand-crafted (curl /
    // server-to-server / a stale browser). None of those are valid
    // entry points for `/api/auth/*` so we fail closed.
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

    // Belt-and-braces — when `Referer` is present, it must agree
    // with `Origin`. A disagreement is the textbook fingerprint of
    // a man-in-the-middle proxy / IDS bypass attempt.
    const referer = request.headers.get('referer');
    if (referer !== null && referer.length > 0) {
        let refererOrigin: string | null = null;
        try {
            refererOrigin = new URL(referer).origin;
        } catch {
            // Malformed referer — same posture as missing origin: deny.
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

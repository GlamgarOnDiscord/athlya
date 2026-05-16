/**
 * Next.js 16 configuration for the Athlya **studio admin** app.
 *
 * Mirrors `apps/web/next.config.ts` 1:1 — the studio app sits behind
 * the same security envelope as the member-facing web app:
 * static security headers (`X-Frame-Options: DENY`,
 * `Referrer-Policy: strict-origin`, HSTS) baked here, the strict CSP
 * with per-request nonce emitted by the Edge proxy in `src/proxy.ts`.
 *
 * Differences vs. `apps/web`:
 *   - dev port 3001 (declared in package.json `dev` script) so both
 *     apps can run side-by-side locally.
 *   - no Turnstile bundling needed in CSP (admins clear the challenge
 *     on `/login`; the same allowlist still applies because the same
 *     login flow is reused).
 *
 * @see Req 25.3, Req 25.4 — requirements.md.
 */
import path from 'node:path';

import type { NextConfig } from 'next';

const workspaceRoot = path.resolve(process.cwd(), '..', '..');

const staticSecurityHeaders = [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    {
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
    },
    // Sprint-3 SP3.1 (Vague 31, audit findings S6-002 / S6-003).
    // Same hardening as `apps/web`. Studio carries admin-role
    // privileges so the post-XSS surface reduction is even more
    // important here than on the member app — see audit-S6 §3.B.
    {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
    reactStrictMode: true,
    // Sprint-3 SP3.1 (S6-004) — drop `X-Powered-By: Next.js`.
    poweredByHeader: false,
    turbopack: { root: workspaceRoot },
    transpilePackages: ['@athlya/shared'],
    async headers() {
        return [{ source: '/:path*', headers: staticSecurityHeaders }];
    },
};

export default nextConfig;

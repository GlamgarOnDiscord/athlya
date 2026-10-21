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

import { resolveDemoMode } from './src/lib/demo/guard';

const workspaceRoot = path.resolve(process.cwd(), '..', '..');

/**
 * Demo mode (issue #750): throws for a production build with the flag on.
 * Re-exported through `env` so `process.env.NEXT_PUBLIC_DEMO_MODE` is
 * always inlined, `'0'` included, and the demo branches fold away.
 */
const demoMode = resolveDemoMode({
  NEXT_PUBLIC_DEMO_MODE: process.env['NEXT_PUBLIC_DEMO_MODE'],
  APP_ENV: process.env['APP_ENV'],
  NEXT_PUBLIC_API_URL: process.env['NEXT_PUBLIC_API_URL'],
});

/**
 * Powerful APIs stay off everywhere. The check-in kiosk is the single
 * exception: it needs the camera to scan member QR codes, so its route
 * gets `camera=(self)` (same origin only) and every other route keeps
 * `camera=()`. The two `source` patterns are disjoint, so no route ever
 * receives two Permissions-Policy headers.
 */
const PERMISSIONS_POLICY_REST =
  'microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()';
const CHECKIN_ROUTE = '/dashboard/checkin';

const staticSecurityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sprint-3 SP3.1 (S6-004) — drop `X-Powered-By: Next.js`.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_DEMO_MODE: demoMode ? '1' : '0',
  },
  turbopack: { root: workspaceRoot },
  transpilePackages: ['@athlya/shared'],
  async headers() {
    // Sprint-3 SP3.1 (Vague 31, audit findings S6-002 / S6-003).
    // Same hardening as `apps/web`. Studio carries admin-role
    // privileges so the post-XSS surface reduction is even more
    // important here than on the member app — see audit-S6 §3.B.
    return [
      {
        source: '/((?!dashboard/checkin(?:/|$)).*)',
        headers: [
          ...staticSecurityHeaders,
          { key: 'Permissions-Policy', value: `camera=(), ${PERMISSIONS_POLICY_REST}` },
        ],
      },
      {
        source: `${CHECKIN_ROUTE}/:path*`,
        headers: [
          ...staticSecurityHeaders,
          { key: 'Permissions-Policy', value: `camera=(self), ${PERMISSIONS_POLICY_REST}` },
        ],
      },
    ];
  },
};

export default nextConfig;

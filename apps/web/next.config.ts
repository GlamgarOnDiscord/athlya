/**
 * Next.js 16 configuration for the Athlya member-facing web app.
 *
 * Task 10.1 — scaffolds the global static security headers required by
 * Req 25.4 (`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin`) plus
 * `Strict-Transport-Security` (Req 25.2) and `X-Content-Type-Options`.
 *
 * The Content-Security-Policy header (Req 25.3) is not emitted here because
 * it needs a fresh per-request nonce — it is set by the Edge proxy in
 * `src/proxy.ts` (Next.js 16's replacement for the legacy `middleware.ts`
 * file convention), which injects the nonce both into a request header
 * (readable by server components) and into the response CSP.
 *
 * TODO(deployment task): wire up `@opennextjs/cloudflare` so this app can
 * ship to Cloudflare Workers alongside the Hono API. Keeping the
 * deployment adapter out of scope for 10.1.
 *
 * @see Req 25.3, Req 25.4 — requirements.md
 */
import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * Workspace root — silences the Turbopack lockfile inference warning
 * triggered by an unrelated `package-lock.json` living further up the
 * filesystem on some developer machines. `process.cwd()` resolves to
 * `apps/web/` when `next build` runs, so we climb two levels.
 */
const workspaceRoot = path.resolve(process.cwd(), '..', '..');

const staticSecurityHeaders = [
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Sprint-3 SP3.1 (Vague 31, audit findings S6-002 / S6-003 /
  // S4-012). Reduce the post-XSS exploitation surface AND isolate
  // the navigation context so a malicious cross-origin window
  // cannot script-poke into our page.
  //
  //   • Permissions-Policy — disables every powerful API the
  //     member app does not use today (camera, microphone,
  //     geolocation, FLoC interest-cohort, payment, USB). A
  //     future feature that legitimately needs one of these flips
  //     the corresponding directive to `(self)`; the default
  //     denies it for now.
  //   • Cross-Origin-Opener-Policy: `same-origin` — opens a fresh
  //     browsing-context group on each navigation, preventing a
  //     window opened via `target="_blank"` from holding a
  //     `window.opener` reference back into our page.
  //   • Cross-Origin-Resource-Policy: `same-origin` — refuses to
  //     be embedded as a resource (img/script/etc.) by another
  //     origin. Strong defence-in-depth on top of `frame-ancestors
  //     'none'` from the CSP.
  //
  // We deliberately do NOT add `Cross-Origin-Embedder-Policy`
  // here: it would block the Cloudflare Turnstile widget loaded
  // from `challenges.cloudflare.com` because that origin does not
  // serve `Cross-Origin-Resource-Policy: cross-origin`. Adding COEP
  // is a separate slice (covered behind a feature flag once
  // Turnstile ships the right CORP header on its own resources).
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()',
  },
  {
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    key: 'Cross-Origin-Resource-Policy',
    value: 'same-origin',
  },
];

const nextConfig: NextConfig = {
  // React Strict Mode is the default in Next 16; pinning it here keeps the
  // behaviour explicit should a future upgrade flip the default.
  reactStrictMode: true,
  // Sprint-3 SP3.1 (Vague 31, audit finding S6-004) — drop the
  // `X-Powered-By: Next.js` header. Information disclosure is
  // never useful to legitimate clients and is a free hint for
  // attackers fingerprinting the stack.
  poweredByHeader: false,
  // Pin the Turbopack workspace root so CI machines with a stray
  // `package-lock.json` further up the tree don't trigger the "multiple
  // lockfiles" inference warning.
  turbopack: {
    root: workspaceRoot,
  },
  // The shared package is workspace source; Next needs to transpile it so
  // Turbopack / Webpack can consume the TypeScript directly in dev, and
  // fall back to the pre-built `dist/*.js` exports in prod. Keeping
  // `transpilePackages` here lets Turbopack ESM-resolve the `.ts`
  // `types`/`default` condition while `dist/*.js` serves the
  // `import` condition for any path Turbopack bundles eagerly.
  transpilePackages: ['@athlya/shared'],
  //
  // Cache Components (PPR) — decision deferred to a dedicated slice.
  // -----------------------------------------------------------------
  // Next.js 16 stabilised `experimental.cacheComponents: true` + the
  // `'use cache'` directive for Partial Prerendering. Enabling it
  // globally would let Next stream a static shell while dynamic
  // fragments resolve — a p75 FCP win on the landing page and /login.
  //
  // We do NOT opt in yet because every current page calls `headers()`
  // (via `getLocale()`) and consumes the per-request CSP nonce from
  // `src/proxy.ts`. Marking a page cacheable while it reads
  // per-request headers is a contract violation that triggers runtime
  // warnings in dev and nondeterministic behaviour in prod.
  //
  // Opting in safely requires refactoring the static shell to live in
  // a dedicated cacheable segment (no headers / cookies / random
  // tokens) and moving the nonce-dependent blocks behind a
  // `<Suspense>` boundary. That is a dedicated slice — P4.5 in the
  // audit backlog — and should land after the Cache Components migration
  // guide in the Next docs is re-read for the current minor.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: staticSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;

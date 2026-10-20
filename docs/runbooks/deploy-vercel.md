# Runbook: Vercel deploy (apps/web + apps/studio)

Issue #744. A second hosting target for the two Next.js 16 front-ends, next to the
OpenNext / Cloudflare Workers one ([`deploy-frontend.md`](./deploy-frontend.md)),
which stays the production path and is not modified. The Hono API stays on
Cloudflare Workers.

**Current scope: test projects only**, `athlya-web` and `athlya-studio`, served on
`https://athlya-web.vercel.app` and `https://athlya-studio.vercel.app`. No custom
domain, no DNS change. The projects are Git-linked and build on push.

## What the repo provides

| App           | Config                    | Vercel Root Directory |
| ------------- | ------------------------- | --------------------- |
| `apps/web`    | `apps/web/vercel.json`    | `apps/web`            |
| `apps/studio` | `apps/studio/vercel.json` | `apps/studio`         |

- `installCommand`: `cd ../.. && pnpm install --frozen-lockfile` (whole workspace,
  same lockfile and `pnpm-workspace.yaml` settings as CI).
- `buildCommand`: `cd ../.. && pnpm exec turbo run build --filter=@athlya/<app>`.
  Turbo builds `@athlya/shared` first (`dependsOn: ["^build"]`) and writes `.next/`
  in the app directory, where the `nextjs` framework preset reads it. Vercel enables
  its Remote Cache for Turbo on its own.
- `ignoreCommand`: `npx turbo-ignore@2.11.9 @athlya/<app>`. A commit that touches
  neither the app nor one of its workspace dependencies (or the lockfile) is not
  built; the first deployment of a new branch is always built.
- `regions: ["cdg1"]` (Paris): the functions (route handlers, SSR) run in the EU.
- No `headers` in `vercel.json` on purpose. Every security header comes from the
  Next build and is served unchanged by Vercel: static headers from `next.config.ts`
  `headers()` (HSTS, `X-Frame-Options`, `Referrer-Policy`, `nosniff`, COOP, CORP,
  `Permissions-Policy` with `camera=(self)` only under `/dashboard/checkin` in
  studio) and the per-request CSP nonce plus `Report-To` from `src/proxy.ts`.
  Repeating them in `vercel.json` would send two `Permissions-Policy` headers on the
  check-in route. `scripts/__tests__/vercel-config.test.mjs` (`pnpm test:scripts`,
  already in `ci.yml`) refuses any unknown key, including `headers`.
- The apps have no Cloudflare-only code path (no `getCloudflareContext`, no
  bindings), so no runtime switch is needed. `.open-next/` and `wrangler.jsonc`
  are simply unused on Vercel.

## Create and link the two projects

For each app, in the team, **Add New Project** → import `GlamgarOnDiscord/athlya`:

1. Project name `athlya-web` / `athlya-studio`, Root Directory `apps/web` /
   `apps/studio`, framework detected as Next.js. Leave the build settings on
   "default": `vercel.json` overrides them.
2. Settings → Build and Deployment: **Node.js 24.x**. Keep "Include files outside
   the Root Directory" on (default), the build needs `packages/*`.
3. Environment variable `ENABLE_EXPERIMENTAL_COREPACK=1` (all environments): Vercel
   then uses the `packageManager` field of the root `package.json` (pnpm 11) instead
   of guessing from the lockfile.
4. Settings → Git: production branch `master`. Settings → Deployment Protection:
   keep Vercel Authentication on previews.

CLI alternative from the repo root: `vercel link --repo` (links both at once).

## Environment variables (names only)

`NEXT_PUBLIC_*` are inlined at build time: a change needs a redeploy. The build
never calls the API (every page renders per request), so an unreachable or
placeholder `NEXT_PUBLIC_API_URL` does not fail it.

| Name                             | App         | Test project value (Production and Preview)    | Read in                                                |
| -------------------------------- | ----------- | ---------------------------------------------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`            | web, studio | staging API origin                             | browser client, BFF upstream, CSP `connect-src`        |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web, studio | Cloudflare **test** key (accepts any hostname) | `src/lib/env.ts`; unset, the forms send no token       |
| `NEXT_PUBLIC_CSP_REPORT_URI`     | web, studio | optional                                       | `src/proxy.ts` (`report-uri` / `report-to`)            |
| `NEXT_PUBLIC_BASE_URL`           | web, studio | web URL / studio URL                           | web `app/robots.ts:3`, `app/sitemap.ts:3`; layouts     |
| `NEXT_PUBLIC_WEB_BASE_URL`       | web         | `https://athlya-web.vercel.app`                | `metadataBase`, `apps/web/src/app/layout.tsx:61-65`    |
| `NEXT_PUBLIC_STUDIO_BASE_URL`    | studio      | `https://athlya-studio.vercel.app`             | `metadataBase`, `apps/studio/src/app/layout.tsx:38-42` |
| `APP_ENV`                        | web, studio | `staging`                                      | runtime; never `development` (drops `Secure` cookies)  |
| `ENABLE_EXPERIMENTAL_COREPACK`   | web, studio | `1`                                            | build only, pnpm 11 from `packageManager`              |

For a real environment, the values are those of the GitHub environment vars of
`deploy-frontend.yml` (`API_URL`, `WEB_URL`, `STUDIO_URL`, `TURNSTILE_SITE_KEY`,
`CSP_REPORT_URI`) and `APP_ENV=production`. No secret is needed: the front-ends
hold none (`TURNSTILE_SECRET_KEY` lives on the API).

## What a live API would need

Pages, headers and CSP work on `*.vercel.app` without any API change. Signed-in
flows against a real API need the following.

1. **CORS.** The browser calls the API directly with a `Bearer` token
   (`apps/web/src/lib/api/use-api-client.ts:20`, `apps/studio/src/lib/api/buildClient.ts:43`).
   The API reflects only origins listed in its comma-separated `CORS_ORIGIN`
   binding, exact match (`packages/api/src/base-app.ts:382-424`, documented in
   `packages/api/src/types.ts:179-195`); `dev` uses a fixed localhost set
   (`base-app.ts:123`). For the test projects, add both origins to the staging
   value: `wrangler secret put CORS_ORIGIN --env staging` with the existing list
   plus `https://athlya-web.vercel.app,https://athlya-studio.vercel.app`. Per-PR
   preview URLs are random and no wildcard is supported, so they stay refused.
2. **BFF auth routes.** `/api/auth/*` route handlers call the API server to server
   (e.g. `apps/web/src/app/api/auth/login/route.ts:77`), so CORS does not apply.
   They first require `Origin` (and `Referer` when sent) to equal
   `request.nextUrl.origin` (`apps/web/src/lib/auth/same-origin.ts:74-110`, same in
   studio), which works on any host. The refresh cookie is host-only,
   `Path=/api/auth`, `SameSite=Lax`, `HttpOnly`, `Secure` unless
   `APP_ENV=development` (`apps/web/src/lib/auth/cookies.ts:72-100`), no `Domain`:
   nothing to change on `vercel.app`.
3. **Client IP.** The API keys its rate limits and the Turnstile `remoteip` on
   `CF-Connecting-IP` (`packages/api/src/middleware/rate-limit.ts:298-315`,
   `packages/api/src/middleware/turnstile.ts:326`). BFF calls from Vercel carry a
   Vercel egress IP, so login / register buckets are shared between users.
4. **Turnstile.** The widget runs on the page origin. The test key passes on any
   hostname; a real key fails with `110200` on `vercel.app` unless the hostname is
   listed in the widget (never list `vercel.app` on the production widget).
5. **CSP.** `connect-src` is `'self'` + `NEXT_PUBLIC_API_URL` + Turnstile
   (`apps/web/src/lib/csp.ts:80,121`, `apps/studio/src/lib/csp.ts:30,45`). Unset,
   every browser API call is blocked.
6. **Absolute URLs.** Only metadata, sitemap and robots use the `*BASE_URL`
   variables; unset, they point at `https://athlya.app` /
   `https://studio.athlya.app`. Vercel serves preview URLs with
   `X-Robots-Tag: noindex`.

## Preview deployments

Every PR touching an app (per `ignoreCommand`) gets a preview with the Preview
variables and a comment from the Vercel bot: public pages, CSP and headers can be
reviewed there. Signed-in flows only work on the two production `vercel.app`
origins once they are in `CORS_ORIGIN` (point 1).

## Custom domains (future, not in scope)

When a real domain moves to Vercel: add it under Settings → Domains, remove the
Worker Custom Domain in Cloudflare, create the `CNAME` Vercel shows as **DNS only**
(grey cloud), wait for "Valid Configuration", then run
`WEB_URL=… STUDIO_URL=… API_URL=… node scripts/smoke-frontend.mjs`. Going back is
the reverse: delete the `CNAME`, re-attach the Worker Custom Domain. Before that,
update `docs/security/deploy-web-adr.md` and the sub-processor list on `/privacy`
(`apps/web/src/app/privacy/page.tsx:94-99`) with Vercel and its DPA (legal copy,
owner decision). Deploy order stays API first
([`deploy-unified.md`](./deploy-unified.md)).

## Rollback

Deployments → previous production deployment → **Instant Rollback**. The Workers
deployments are not affected by anything on Vercel.

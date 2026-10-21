# Runbook: demo mode (apps/web + apps/studio)

Issue #750. A build-time switch that runs the member web app and the studio on
fictional in-memory data, with no API and no database. It exists for the Vercel
**test** projects `athlya-web` and `athlya-studio` (`https://athlya-web.vercel.app`,
`https://athlya-studio.vercel.app`, see the Vercel deploy runbook of #744), while
the staging API and database lag behind `master`.

## Turn it on (test projects only)

In each Vercel test project, Settings → Environment Variables, Production and
Preview:

| Name                    | Value                                   |
| ----------------------- | --------------------------------------- |
| `NEXT_PUBLIC_DEMO_MODE` | `1`                                     |
| `NEXT_PUBLIC_API_URL`   | any non-production origin, e.g. staging |
| `APP_ENV`               | `staging` (anything but `production`)   |

The value is read at build time: redeploy after a change. Only the exact value `1`
turns it on. Turnstile is not loaded in a demo build, so
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` can stay unset there. Remove the variable (or set
it to `0`) and redeploy to go back to the real API.

## The production guard

`next.config.ts` of each app calls `resolveDemoMode()` (`src/lib/demo/guard.ts`).
With the flag on, the build **fails** when `APP_ENV=production` or when
`NEXT_PUBLIC_API_URL` points at `api.athlya.app`. Both variables are part of the
Turbo `build` hash (`turbo.json`), so a cached demo build is never replayed for a
production one. The OpenNext / Cloudflare build sets neither flag nor value and is
unchanged.

The resolved value is re-exported through Next `env`, so every
`process.env.NEXT_PUBLIC_DEMO_MODE === '1'` check is a compile-time constant. A
normal build folds them to `false`: the fake API, its fixtures and the fetch
transport are never bundled (only the two demo components remain, as empty
`return null` stubs). Check it with
`grep -rlF 'Studio Rive Gauche' apps/*/.next --include=*.js` after a normal build:
no match.

## What a demo build does

- `src/components/demo/DemoBanner.tsx` shows a "Démo" banner on every page and, on
  import, wraps `window.fetch` (`src/lib/demo/transport.ts`). Requests to the
  `NEXT_PUBLIC_API_URL` origin, same-origin `/v1/*` and the BFF `/api/auth/*`
  routes are answered by `src/lib/demo/fake-api.ts`; nothing else is intercepted
  and nothing reaches the network or the Next route handlers.
- `/login` shows a one-click profile picker instead of the form: web, the member
  Léa Fontaine; studio, the admin Camille Durand or the coach Inès Garnier. No
  password, no Turnstile, no refresh cookie: the token is an opaque
  `demo-session-*` string in memory.
- Fixtures (`src/lib/demo/fixtures.ts`): "Studio Rive Gauche", fourteen people,
  classes from twelve weeks back to five weeks ahead with full classes and
  waitlists, bookings, programs, audit entries, progression and coach answers.
  Dates follow the current week.
- Mutations (book, cancel, waitlist, profile and consents, class create, edit and
  delete, check-in, branding, programs) update the state, kept in
  `sessionStorage` for the tab. A new tab starts from the seed again.
- The member settings (`/me/settings/*`) work end to end: "sign out everywhere"
  (`POST /v1/auth/logout-all`) and account deletion end the demo session like a
  sign-out, and the data export answers with a fictional job.
- An endpoint the fake does not know answers `404` with code `demo_not_available`.
  A new page that calls a new endpoint needs a route in `fake-api.ts`.

## Test it locally

```bash
NEXT_PUBLIC_DEMO_MODE=1 NEXT_PUBLIC_API_URL=https://athlya-api.invalid pnpm --filter @athlya/web build
NEXT_PUBLIC_DEMO_MODE=1 NEXT_PUBLIC_API_URL=https://athlya-api.invalid \
  pnpm --filter @athlya/web exec playwright test --config e2e/demo.config.ts
```

Same for `@athlya/studio` (port 3001). The specs in `e2e/demo/` fail on any
request to the API origin, `/v1/*` or `/api/auth/*`, and on any console error.
Without the flag they are skipped, so the regular e2e runs are unaffected. The
unit tests (`src/lib/demo/*.test.ts`) run in `pnpm test`.

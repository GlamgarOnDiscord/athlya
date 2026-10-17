/**
 * Playwright configuration for the studio post-deploy release smoke (#422).
 *
 * Unlike `playwright.config.ts` (hermetic: local server + `page.route()`
 * stubs), this config starts no server and stubs nothing: it drives the
 * deployed Worker at `STUDIO_URL`, which talks to the real API.
 *
 * Scope (`RELEASE_SMOKE_SCOPE`):
 *  - `full` (default, staging): every spec. Requires `API_URL`,
 *    `SMOKE_ADMIN_EMAIL` and `SMOKE_ADMIN_PASSWORD`.
 *  - `public` (production): anonymous specs only. `@turnstile` specs log
 *    in through a Turnstile-protected form, which only a staging
 *    deployment on Cloudflare's test keys lets a headless browser pass;
 *    the production secret is real (docs/runbooks/canary-deploy.md).
 * A missing variable aborts the run before any test starts.
 *
 * Run:
 *   STUDIO_URL=… API_URL=… SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… \
 *     pnpm --filter @athlya/studio e2e:release
 */
import { defineConfig } from '@playwright/test';

import { releaseScope, requireEnv } from './release/support';

const scope = releaseScope();
const { STUDIO_URL } = requireEnv(['STUDIO_URL']);
if (scope === 'full') requireEnv(['API_URL', 'SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD']);

export default defineConfig({
  testDir: './release',
  testMatch: '**/*.release.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: true,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  ...(scope === 'public' ? { grepInvert: /@turnstile/ } : {}),
  use: {
    baseURL: STUDIO_URL,
    headless: true,
    locale: 'fr-FR',
    // `datetime-local` inputs use the browser time zone; UTC keeps the
    // value typed in the class form equal to the instant sent to the API.
    timezoneId: 'UTC',
    // Traces and videos would record the admin credentials typed into
    // the login form; keep only a screenshot of the failing page.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});

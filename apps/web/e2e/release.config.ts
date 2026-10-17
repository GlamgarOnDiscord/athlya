/**
 * Playwright configuration for the web post-deploy release smoke (#422).
 *
 * Unlike `playwright.config.ts` (hermetic: local server + `page.route()`
 * stubs), this config starts no server and stubs nothing: it drives the
 * deployed Worker at `WEB_URL`, which talks to the real API.
 *
 * Scope (`RELEASE_SMOKE_SCOPE`):
 *  - `full` (default, staging): every spec. Requires `API_URL`,
 *    `SMOKE_EMAIL` and `SMOKE_PASSWORD`.
 *  - `public` (production): anonymous specs only. `@turnstile` specs
 *    submit a Turnstile-protected form, which only a staging deployment
 *    on Cloudflare's test keys lets a headless browser pass; the
 *    production secret is real (docs/runbooks/canary-deploy.md).
 * A missing variable aborts the run before any test starts.
 *
 * Run:
 *   WEB_URL=… API_URL=… SMOKE_EMAIL=… SMOKE_PASSWORD=… \
 *     pnpm --filter @athlya/web e2e:release
 */
import { defineConfig } from '@playwright/test';

import { releaseScope, requireEnv } from './release/support';

const scope = releaseScope();
const { WEB_URL } = requireEnv(['WEB_URL']);
if (scope === 'full') requireEnv(['API_URL', 'SMOKE_EMAIL', 'SMOKE_PASSWORD']);

export default defineConfig({
  testDir: './release',
  testMatch: '**/*.release.ts',
  // Real network, shared smoke account: run the flows one at a time.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: true,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  ...(scope === 'public' ? { grepInvert: /@turnstile/ } : {}),
  use: {
    baseURL: WEB_URL,
    headless: true,
    locale: 'fr-FR',
    timezoneId: 'UTC',
    // Traces and videos would record the smoke credentials typed into
    // the forms; keep only a screenshot of the failing page.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});

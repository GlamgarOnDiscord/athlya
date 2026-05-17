/**
 * Playwright configuration for Athlya web accessibility checks.
 *
 * Scope: this project only runs axe-core (WCAG 2.2 AA) sweeps over
 * the five member-facing pages called out in Task 10.7. It is
 * intentionally kept separate from the Vitest unit-test suite:
 *
 *  - Vitest runs `src/**\/*.test.ts(x)` under jsdom.
 *  - Playwright runs `apps/web/e2e/**` against a real headless
 *    Chromium talking to the live Next.js dev server.
 *
 * The `webServer` block lets CI run `pnpm e2e` without a manual
 * pre-step: Playwright spawns the dev server, waits for `/` to
 * become reachable, and tears it down at the end of the run.
 * Locally, `reuseExistingServer: true` avoids clobbering a dev
 * server the developer already started.
 *
 * @see Requirements 27.1, 27.2.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 2 : 0,
  // Start the Next.js app in the background. CI always gets a
  // fresh server; local dev reuses whatever is already bound to
  // :3000 to avoid the 10–20 s Next.js cold start on every run.
  webServer: {
    command: 'pnpm --filter @athlya/web dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // Headless everywhere — CI has no display, and the axe sweep
    // does not benefit from a visible browser.
    headless: true,
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});

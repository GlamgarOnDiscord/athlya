/**
 * Playwright config of the demo build smoke test (issue #750). Build the
 * app with `NEXT_PUBLIC_DEMO_MODE=1` first, then run with the same flag:
 *
 *   NEXT_PUBLIC_DEMO_MODE=1 pnpm --filter @athlya/web build
 *   NEXT_PUBLIC_DEMO_MODE=1 pnpm --filter @athlya/web exec playwright test --config e2e/demo.config.ts
 *
 * `DEMO_PORT` points it at a server already running on another port.
 */
import { defineConfig } from '@playwright/test';

const port = process.env['DEMO_PORT'] ?? '3000';

export default defineConfig({
  testDir: './demo',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  webServer: {
    command: `pnpm --filter @athlya/web start --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});

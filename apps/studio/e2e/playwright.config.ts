import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 2 : 0,
  webServer: {
    command: 'pnpm --filter @athlya/studio start',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});

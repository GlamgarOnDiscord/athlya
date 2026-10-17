/**
 * Anonymous browser pass on the deployed studio Worker (issue #422).
 *
 * Proves the studio runs in a browser under its per-request CSP: the
 * login page hydrates, no script is refused, and the admin guard reaches
 * the real refresh route and sends an anonymous visitor from the classes
 * table to `/login`. It runs in production too.
 */
import { expect, test, type Page } from '@playwright/test';

import { isCall } from './support';

/** Collects CSP refusals and uncaught page errors for the whole test. */
function watchForBreakage(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/iu.test(message.text())) {
      problems.push(`CSP: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    problems.push(`page error: ${error.message}`);
  });
  return problems;
}

test('anonymous visitor is sent from the classes table to /login', async ({ page }) => {
  const problems = watchForBreakage(page);

  const refresh = page.waitForResponse(isCall('POST', '/api/auth/refresh'));
  await page.goto('/dashboard/classes');
  const refreshed = await refresh;
  expect(refreshed.status(), 'anonymous refresh must be refused, not crash').toBeLessThan(500);
  expect(refreshed.status()).toBeGreaterThanOrEqual(400);

  await page.waitForURL((url) => url.pathname === '/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/^(adresse e-mail|email address)$/iu)).toBeEditable();
  expect(problems, problems.join('\n')).toEqual([]);
});

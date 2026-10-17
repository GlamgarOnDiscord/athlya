/**
 * Anonymous browser pass on the deployed web Worker (issue #422).
 *
 * `scripts/smoke-frontend.mjs` checks status codes and headers; this pass
 * proves the pages actually run in a browser under the per-request CSP:
 * the bundle hydrates, no script is refused, and the client-side auth
 * guard reaches the real refresh route and sends an anonymous visitor
 * from `/classes` to `/login`. It runs in production too.
 */
import { expect, test, type Page } from '@playwright/test';

import { dismissCookieBanner } from './support';

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

test('public pages hydrate under the CSP', async ({ page }) => {
  const problems = watchForBreakage(page);

  await page.goto('/');
  await dismissCookieBanner(page);

  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByLabel(/^(adresse e-mail|email address)$/iu)).toBeEditable();

  await page.goto('/forgot-password');
  await expect(
    page.getByRole('button', { name: /envoyer le lien|send reset link/iu }),
  ).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
});

test('anonymous visitor is sent from /classes to /login', async ({ page }) => {
  const problems = watchForBreakage(page);

  const refresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/refresh' &&
      response.request().method() === 'POST',
  );
  await page.goto('/classes');
  const refreshed = await refresh;
  expect(refreshed.status(), 'anonymous refresh must be refused, not crash').toBeLessThan(500);
  expect(refreshed.status()).toBeGreaterThanOrEqual(400);

  await page.waitForURL((url) => url.pathname === '/login');
  expect(problems, problems.join('\n')).toEqual([]);
});

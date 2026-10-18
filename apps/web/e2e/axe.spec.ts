/**
 * WCAG 2.2 AA accessibility sweep using axe-core.
 *
 * Runs axe over every member-facing page called out in Task 10.7:
 *  - Public: `/`, `/login`, `/register`
 *  - Authenticated: `/classes`, `/me`, `/me/export`, `/me/delete`
 *  - `/me/progression` in its own case: the boot refresh is stubbed so
 *    the charts render from the stubbed payload before axe runs
 *
 * For authenticated pages we use the `loginWithStub` fixture so the
 * token store is populated without a real API round-trip — we care
 * about the rendered DOM, not the auth backend.
 *
 * The tag set `wcag2a + wcag2aa + wcag22aa` matches the WCAG 2.2 AA
 * compliance target expressed in Req 27.1. We assert `violations`
 * is empty rather than "at most N" so regressions are caught the
 * moment they appear.
 *
 * @see Requirements 27.1, 27.2.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { loginWithStub } from './fixtures/auth';

const publicPaths = ['/', '/login', '/register'] as const;
const authPaths = ['/classes', '/me', '/me/export', '/me/delete'] as const;

for (const path of publicPaths) {
  test(`axe: ${path} (public)`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

for (const path of authPaths) {
  test(`axe: ${path} (authenticated)`, async ({ page }) => {
    await loginWithStub(page);
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test('axe: /me/progression (authenticated, charts rendered)', async ({ page }) => {
  await loginWithStub(page);
  // `page.goto` reloads the app and drops the in-memory token; the boot
  // silent refresh must succeed for RequireAuth to render the charts.
  await page.route('**/api/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'fake-access-token', accessTokenExpiresIn: 900 }),
    });
  });
  await page.goto('/me/progression');
  // Analyse the rendered charts (marks, data tables), not the loading state.
  await expect(page.getByRole('figure')).toHaveCount(3);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

/**
 * Smoke test of a demo build (issue #750): the member signs in from the
 * role picker, books and cancels a class, with no request to the API and
 * no console error. Skipped unless the runner has `NEXT_PUBLIC_DEMO_MODE=1`
 * (see `e2e/demo.config.ts`).
 */
import { expect, test, type Page } from '@playwright/test';

test.skip(process.env['NEXT_PUBLIC_DEMO_MODE'] !== '1', 'needs a NEXT_PUBLIC_DEMO_MODE=1 build');

function watch(page: Page): { readonly errors: string[]; readonly apiCalls: string[] } {
  const errors: string[] = [];
  const apiCalls: string[] = [];
  const apiOrigin = process.env['NEXT_PUBLIC_API_URL'];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/auth/')) {
      apiCalls.push(request.url());
    } else if (
      apiOrigin !== undefined &&
      apiOrigin !== '' &&
      url.origin === new URL(apiOrigin).origin
    ) {
      apiCalls.push(request.url());
    }
  });
  return { errors, apiCalls };
}

test('member demo: pick the profile, book and cancel a class', async ({ page }) => {
  const seen = watch(page);
  await page.addLocatorHandler(
    page.locator('[aria-labelledby="cookie-banner-title"]'),
    async () => {
      await page.getByRole('button', { name: 'Tout refuser' }).click();
    },
  );

  await page.goto('/login');
  await expect(page.getByRole('note')).toContainText('Démo');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole('button', { name: /Léa Fontaine/u }).click();
  await page.waitForURL('**/classes');

  const book = page.getByRole('button', { name: /^Réserver/u }).first();
  await book.click();
  await expect(page.getByText('Réservation confirmée').first()).toBeVisible();

  await page.goto('/me');
  await expect(page.getByLabel('Nom affiché')).toHaveValue('Léa Fontaine');
  await page
    .getByRole('button', { name: /^Annuler/u })
    .first()
    .click();
  await page.getByRole('button', { name: 'Oui, annuler' }).click();
  await expect(page.getByText(/Réservation annulée/u).first()).toBeVisible();

  expect(seen.apiCalls).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('member demo: sign out everywhere from the security settings', async ({ page }) => {
  const seen = watch(page);
  await page.addLocatorHandler(
    page.locator('[aria-labelledby="cookie-banner-title"]'),
    async () => {
      await page.getByRole('button', { name: 'Tout refuser' }).click();
    },
  );

  await page.goto('/login');
  await page.getByRole('button', { name: /Léa Fontaine/u }).click();
  await page.waitForURL('**/classes');

  await page.goto('/me/settings/security');
  await page.getByRole('button', { name: 'Se déconnecter partout', exact: true }).click();
  await page.getByRole('button', { name: 'Oui, tout déconnecter' }).click();
  await page.waitForURL('**/login');
  await expect(page.getByRole('button', { name: /Léa Fontaine/u })).toBeVisible();

  expect(seen.apiCalls).toEqual([]);
  expect(seen.errors).toEqual([]);
});

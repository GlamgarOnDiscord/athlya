/**
 * Smoke test of a demo build (issue #750): the admin signs in from the
 * role picker, sees the dashboard and checks a member in by hand, then the
 * manager lands on the studio overview and the front desk and the coach on
 * the day home, with no request to the API and no console error. Skipped unless the runner has `NEXT_PUBLIC_DEMO_MODE=1`
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

test('admin demo: dashboard, members, audit and a manual check-in', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/login');
  await expect(page.getByRole('note')).toContainText('Démo');
  await page.getByRole('button', { name: /Camille Durand/u }).click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByRole('heading', { name: 'Bonjour Camille' })).toBeVisible();

  await page.goto('/dashboard/members');
  await expect(page.getByText('Inès Garnier').first()).toBeVisible();
  await page.goto('/dashboard/audit');
  await expect(page.getByText('user.registered').first()).toBeVisible();

  await page.goto('/dashboard/checkin');
  await page.getByLabel('Token QR').fill('demo-token');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText(/Bienvenue, Lucas Bertin/u)).toBeVisible();

  expect(seen.apiCalls).toEqual([]);
  expect(seen.errors).toEqual([]);
});

for (const [role, name, firstName] of [
  ['manager', 'Hugo Lefebvre', 'Hugo'],
  ['front desk', 'Sarah Benali', 'Sarah'],
  ['coach', 'Inès Garnier', 'Inès'],
] as const) {
  test(`${role} demo: the landing page greets ${firstName}`, async ({ page }) => {
    const seen = watch(page);
    await page.goto('/login');
    await page.getByRole('button', { name: new RegExp(name, 'u') }).click();
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('heading', { name: `Bonjour ${firstName}` })).toBeVisible();

    expect(seen.apiCalls).toEqual([]);
    expect(seen.errors).toEqual([]);
  });
}

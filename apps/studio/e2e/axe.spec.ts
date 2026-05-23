import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { loginAsAdmin } from './fixtures/auth';

const publicPaths = ['/login'] as const;

const adminPaths = [
  '/dashboard',
  '/dashboard/classes',
  '/dashboard/members',
  '/dashboard/branding',
  '/dashboard/billing',
  '/dashboard/checkin',
  '/dashboard/audit',
] as const;

for (const path of publicPaths) {
  test(`axe: ${path} (public)`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

for (const path of adminPaths) {
  test(`axe: ${path} (admin)`, async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

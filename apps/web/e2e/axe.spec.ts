/**
 * WCAG 2.2 AA accessibility sweep using axe-core.
 *
 * Runs axe over every member-facing page called out in Task 10.7:
 *  - Public: `/`, `/login`, `/register`
 *  - Authenticated: `/classes`, `/me`, `/me/export`, `/me/delete`,
 *    `/me/progression` (strength and cardio charts rendered), `/me/checkin` (QR
 *    code rendered) and `/me/coach` (answer rendered)
 *
 * Authenticated pages are opened through `openAuthenticatedPage`, which
 * stubs the boot refresh and the member API reads, then waits for
 * markup that only exists inside the page's `<RequireAuth>` subtree and
 * checks the URL did not move. Without that guard a missing stub sends
 * the page to `/login` and axe silently scans the login form instead.
 *
 * The tag set `wcag2a + wcag2aa + wcag22aa` matches the WCAG 2.2 AA
 * compliance target expressed in Req 27.1. We assert `violations`
 * is empty rather than "at most N" so regressions are caught the
 * moment they appear.
 *
 * @see Requirements 27.1, 27.2.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { openAuthenticatedPage } from './fixtures/auth';

const publicPaths = ['/', '/login', '/register'] as const;

const authPages: ReadonlyArray<{
  readonly path: string;
  readonly rendered: (page: Page) => Locator;
}> = [
  {
    path: '/classes',
    rendered: (page) => page.getByRole('button', { name: /^(réserver|book) — morning yoga$/i }),
  },
  {
    path: '/me',
    rendered: (page) =>
      page.getByRole('navigation', { name: /actions du compte|account actions/i }),
  },
  {
    path: '/me/export',
    rendered: (page) => page.getByRole('region', { name: /exporter mes données|export my data/i }),
  },
  {
    path: '/me/delete',
    rendered: (page) =>
      page.getByRole('region', { name: /supprimer mon compte|delete my account/i }),
  },
];

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const path of publicPaths) {
  test(`axe: ${path} (public)`, async ({ page }) => {
    await page.goto(path);
    await expectNoViolations(page);
  });
}

for (const { path, rendered } of authPages) {
  test(`axe: ${path} (authenticated)`, async ({ page }) => {
    await openAuthenticatedPage(page, path, rendered(page));
    await expectNoViolations(page);
  });
}

test('axe: /me/progression (authenticated, charts rendered)', async ({ page }) => {
  const figures = page.getByRole('figure');
  await openAuthenticatedPage(page, '/me/progression', figures.first());
  // Analyse the rendered charts (marks, data tables), not the loading state:
  // three strength charts, then the cardio distance, power and speed charts.
  await expect(figures).toHaveCount(6);
  await expectNoViolations(page);
});

test('axe: /me/checkin (authenticated, QR code rendered)', async ({ page }) => {
  await openAuthenticatedPage(page, '/me/checkin', page.getByTestId('checkin-qr'));
  await expectNoViolations(page);
});

test('axe: /me/coach (authenticated, answer rendered)', async ({ page }) => {
  // The streamed answer (`Accept: text/event-stream`): one partial
  // snapshot, then the validated answer.
  await page.route('**/v1/coach/ask', async (route) => {
    const partial = { summary: 'Your squat volume is steady' };
    const answer = {
      advice: {
        summary: 'Your squat volume is steady over the last four weeks.',
        recommendations: [
          { title: 'Add a back-off set', detail: 'One set at 80 % after your top set.' },
        ],
        caution: null,
      },
      quota: { limit: 10, remaining: 8, resetsAt: '2026-10-16T00:00:00.000Z' },
      generatedAt: '2026-10-15T14:30:00.000Z',
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        `event: partial\ndata: ${JSON.stringify(partial)}\n\n` +
        `event: done\ndata: ${JSON.stringify(answer)}\n\n`,
    });
  });
  const askButton = page.getByRole('button', { name: /interroger le coach|ask the coach/i });
  await openAuthenticatedPage(page, '/me/coach', askButton);
  await page.getByRole('textbox').fill('How do I add weight to my squat?');
  // Submit with the keyboard: the fixed cookie banner covers the button
  // for pointer clicks, and keeping it on screen keeps it in the scan.
  await askButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article')).toBeVisible();
  await expectNoViolations(page);
});

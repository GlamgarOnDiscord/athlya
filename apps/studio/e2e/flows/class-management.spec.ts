/**
 * End-to-end: admin creates a class → row appears in table.
 *
 * Coverage
 * --------
 *  1. **Auth** — boot refresh stubbed via `loginAsAdmin`; admin token
 *     populates the in-memory store without walking the login form.
 *  2. **Classes list (empty)** — `GET /v1/classes` stubbed with an empty
 *     `items` array. The empty-state row "No classes in this range" must
 *     be visible before the form is submitted.
 *  3. **POST** — admin fills the `ClassFormDialog`, submits;
 *     `POST /v1/classes` is stubbed to return the created class. After
 *     the dialog closes, a subsequent `GET /v1/classes` returns the row
 *     so the class title must appear in the table.
 *
 * The test is hermetic: no running Hono API or Redis is needed.
 * All `/v1/*` and `/api/*` requests are intercepted via
 * `page.route()` before the browser sends them. The `loginAsAdmin`
 * fixture registers a catch-all for `GET /v1/classes`; this file
 * registers a more specific handler *after* (LIFO precedence) that
 * intercepts POST and the post-creation GET.
 *
 * @see Requirements 14.1, 14.2, 14.3.
 */
import { expect, test, type Request, type Route } from '@playwright/test';

import { loginAsAdmin } from '../fixtures/auth';

const CREATED_CLASS = {
  id: 'class-1',
  studioId: 'studio-1',
  title: 'Morning Yoga',
  startsAt: '2030-06-01T09:00:00.000Z',
  durationMin: 60,
  capacity: 12,
  remaining: 12,
  version: 0,
};

test('admin creates a class → row appears in table (hermetic)', async ({ page }) => {
  await loginAsAdmin(page);

  // Override the classes stub registered by loginAsAdmin (LIFO: this
  // handler is checked first). POST records the call and flips
  // `classCreated`; the next GET returns the new row; initial GETs fall
  // through to loginAsAdmin's empty-list handler.
  let classCreated = false;
  const postCalls: Request[] = [];

  await page.route('**/v1/classes*', async (route: Route) => {
    if (route.request().method() === 'POST') {
      postCalls.push(route.request());
      classCreated = true;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(CREATED_CLASS),
      });
    } else if (classCreated) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [CREATED_CLASS] }),
      });
    } else {
      await route.fallback();
    }
  });

  await page.goto('/dashboard/classes');

  // Empty state must be visible before creation (Req 14.1).
  await expect(page.getByText(/no classes in this range|aucun cours/i)).toBeVisible();

  // Open the create dialog.
  await page.getByRole('button', { name: /\+ new class|\+ nouveau cours/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Fill mandatory fields. durationMin (60) and capacity (12) keep their
  // defaults; only title and startsAt need explicit values.
  await page.getByLabel(/^title$|^titre$/i).fill('Morning Yoga');
  await page.locator('input[type="datetime-local"]').fill('2030-06-01T09:00');

  // Submit — "Create" / "Créer".
  await page.getByRole('button', { name: /^create$|^créer$/i }).click();

  // Dialog must close (Req 14.2).
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });

  // Class title must appear in the table (Req 14.3).
  await expect(page.getByText('Morning Yoga')).toBeVisible();

  // POST must have fired exactly once.
  expect(postCalls).toHaveLength(1);
});

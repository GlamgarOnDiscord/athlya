/**
 * Studio admin journey on the deployed studio Worker and the real API
 * (#422): log in → classes table → create a class → delete it.
 *
 * The class is created 100 days ahead: outside the member app's 14-day
 * list and the staging gate's 90-day booking window, so no smoke member
 * books it while it exists. `afterEach` deletes it through the API if a
 * step after the creation failed or timed out, and every run first sweeps
 * classes left by a run that was killed outright, so the studio never
 * accumulates smoke classes.
 */
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';

import { isCall, requireEnv, runTag, waitForSubmittable } from './support';

const TITLE_PREFIX = 'Release smoke ';
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_DAYS = 100;
/** `GET /v1/classes` rejects ranges longer than 90 days. */
const SWEEP_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [0, 90],
  [90, 180],
];

interface Created {
  readonly classId: string;
  readonly accessToken: string;
}

let created: Created | null = null;

async function withApi<T>(fn: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await playwrightRequest.newContext();
  try {
    return await fn(api);
  } finally {
    await api.dispose();
  }
}

async function deleteClass(apiUrl: string, { classId, accessToken }: Created): Promise<number> {
  return withApi(async (api) => {
    const res = await api.delete(`${apiUrl}/v1/classes/${classId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      timeout: 15_000,
    });
    return res.status();
  });
}

/** Deletes smoke classes a killed run could not clean up. */
async function sweepStaleClasses(apiUrl: string, accessToken: string): Promise<void> {
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  for (const [start, end] of SWEEP_WINDOWS) {
    const range = new URLSearchParams({
      from: new Date(today + start * DAY_MS).toISOString(),
      to: new Date(today + end * DAY_MS - 1).toISOString(),
    });
    const items = await withApi(async (api) => {
      const res = await api.get(`${apiUrl}/v1/classes?${range.toString()}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        timeout: 15_000,
      });
      expect(res.status(), 'GET /v1/classes (sweep)').toBe(200);
      return ((await res.json()) as { items: Array<{ id: string; title: string }> }).items;
    });
    for (const item of items.filter((c) => c.title.startsWith(TITLE_PREFIX))) {
      const status = await deleteClass(apiUrl, { classId: item.id, accessToken });
      console.log(`[release-smoke] swept stale class ${item.id} (HTTP ${String(status)})`);
    }
  }
}

test.afterEach(async () => {
  if (created === null) return;
  const pending = created;
  created = null;
  const { API_URL } = requireEnv(['API_URL']);
  const status = await deleteClass(API_URL, pending).catch(() => 0);
  if (status !== 204 && status !== 404) {
    // Fail the run: a class left behind must not pass silently.
    throw new Error(
      `[release-smoke] could not delete class ${pending.classId} (HTTP ${String(status)}); ` +
        'the next run sweeps it, or delete it manually',
    );
  }
});

test('studio admin: log in → classes table → create → delete @turnstile', async ({
  page,
}, testInfo) => {
  const { API_URL, SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD } = requireEnv([
    'API_URL',
    'SMOKE_ADMIN_EMAIL',
    'SMOKE_ADMIN_PASSWORD',
  ]);

  // ---------------------------------------------------------------- login
  await page.goto('/login');
  await page.getByLabel(/^(adresse e-mail|email address)$/iu).fill(SMOKE_ADMIN_EMAIL);
  await page.getByLabel(/^(mot de passe|password)$/iu).fill(SMOKE_ADMIN_PASSWORD);
  const submit = page.getByRole('button', { name: /^(se connecter|sign in)$/iu });
  await waitForSubmittable(submit);

  const loginResponse = page.waitForResponse(isCall('POST', '/api/auth/login'));
  await submit.click();
  const login = await loginResponse;
  expect(login.status(), 'login through /api/auth/login').toBe(200);
  const session = (await login.json()) as { accessToken?: unknown; user?: { role?: unknown } };
  expect(session.user?.role, 'SMOKE_ADMIN_EMAIL must be a studio admin').toBe('admin');
  expect(typeof session.accessToken, 'login returns an access token').toBe('string');
  const accessToken = String(session.accessToken);
  await page.waitForURL((url) => url.pathname === '/dashboard');

  await sweepStaleClasses(API_URL, accessToken);

  // -------------------------------------------------------- classes table
  // A full navigation drops the in-memory token: the table only loads if
  // the refresh cookie set by the login round-trips.
  const listResponse = page.waitForResponse(isCall('GET', '/v1/classes'));
  await page.goto('/dashboard/classes');
  expect((await listResponse).status(), 'GET /v1/classes').toBe(200);
  // The page opens on the week planning; the table lives in the List view.
  await page.getByRole('button', { name: /^(liste|list)$/iu }).click();
  await expect(page.getByRole('columnheader', { name: /^(cours|classes)$/iu })).toBeVisible();

  // The list shows one calendar month: step forward to the month the smoke class lands on.
  const day = new Date(Date.now() + LEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
  const monthIndex = (iso: string): number =>
    Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
  const monthsAhead = monthIndex(day) - monthIndex(new Date().toISOString());
  for (let step = 0; step < monthsAhead; step++) {
    const stepResponse = page.waitForResponse(isCall('GET', '/v1/classes'));
    await page.getByRole('button', { name: /^(mois suivant|next month)$/iu }).click();
    expect((await stepResponse).status(), 'GET /v1/classes (next month)').toBe(200);
  }

  // --------------------------------------------------------------- create
  const title = `${TITLE_PREFIX}${runTag(testInfo.retry)}`;
  await page.getByRole('button', { name: /^\+ (nouveau cours|new class)$/iu }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^(titre|title)$/iu).fill(title);
  await dialog.locator('input[type="datetime-local"]').fill(`${day}T06:00`);

  const createResponse = page.waitForResponse(isCall('POST', '/v1/classes'));
  await dialog.getByRole('button', { name: /^(créer|create)$/iu }).click();
  const create = await createResponse;
  expect(create.status(), 'POST /v1/classes').toBe(201);
  const body = (await create.json()) as { id?: unknown };
  expect(typeof body.id, 'create returns the class id').toBe('string');
  const classId = String(body.id);
  created = { classId, accessToken };

  await expect(dialog).toBeHidden();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toBeVisible();

  // --------------------------------------------------------------- delete
  await row.getByRole('button', { name: /^(supprimer|delete)$/iu }).click();
  const deleteResponse = page.waitForResponse(isCall('DELETE', `/v1/classes/${classId}`));
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^(supprimer|delete)$/iu })
    .click();
  expect((await deleteResponse).status(), 'DELETE /v1/classes/:id').toBe(204);
  created = null;
  await expect(row).toHaveCount(0);
});

/**
 * End-to-end: login → edit profile display name → success.
 *
 * Coverage
 * --------
 *  1. **Login** — `POST /api/auth/login` stubbed; token populates
 *     the in-memory store exactly as a real login would.
 *  2. **Profile load** — `GET /v1/members/me` stubbed with an initial
 *     profile carrying `displayName: 'Alice'`. The `ProfileSection`
 *     umbrella fetches this on mount and pre-fills the form.
 *  3. **PATCH** — user edits the `displayName` field and submits;
 *     `PATCH /v1/members/me` is stubbed to echo back the patched
 *     name. The success banner "Profil mis à jour" must become
 *     visible and the stub must have observed exactly one PATCH with
 *     the new display name.
 *
 * The test is hermetic: no running Hono API or Redis is needed.
 * All `/v1/*` and `/api/*` requests are intercepted via
 * `page.route()` before the browser sends them.
 *
 * @see Requirements 3.1, 3.2, 3.4.
 */
import { expect, test, type Request, type Route } from '@playwright/test';

const FAKE_USER = {
  id: 'user-1',
  email: 'alice@athlya.app',
  displayName: 'Alice',
};

function profilePayload(displayName: string): Record<string, unknown> {
  return {
    id: FAKE_USER.id,
    email: FAKE_USER.email,
    displayName,
    avatarUrl: null,
    consents: {
      marketing: false,
      analytics: false,
      thirdParty: false,
      version: '2026-01',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

test('login → edit display name → success banner (hermetic)', async ({ page }) => {
  // Boot refresh — AuthProvider fires this on every page mount.
  await page.route('**/api/auth/refresh', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'fake-access-token',
        accessTokenExpiresIn: 900,
        user: FAKE_USER,
      }),
    });
  });

  await page.route('**/api/auth/login', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: 'fake-access-token',
        accessTokenExpiresIn: 900,
        user: FAKE_USER,
      }),
    });
  });

  // Classes stub — prevents 404 noise when RequireAuth renders /classes.
  await page.route('**/v1/classes*', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  // Upcoming bookings on `/classes` and `/me`: none.
  await page.route('**/v1/reservations/me*', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });

  // Members/me — handles both GET (initial load) and PATCH (update).
  const patchCalls: Request[] = [];
  await page.route('**/v1/members/me', async (route: Route) => {
    if (route.request().method() === 'PATCH') {
      patchCalls.push(route.request());
      const body = route.request().postDataJSON() as { displayName?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(profilePayload(body.displayName ?? FAKE_USER.displayName)),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(profilePayload(FAKE_USER.displayName)),
      });
    }
  });

  // Walk the real login form so the client-side token store is
  // populated exactly the way a human login would populate it.
  await page.goto('/login');

  // Dismiss cookie consent banner if present (fixed bottom bar can
  // intercept pointer events on form elements underneath it).
  await page
    .getByRole('button', { name: /tout refuser|refuse all/i })
    .click({ timeout: 5_000 })
    .catch(() => undefined);

  await page.getByLabel(/adresse e-mail|email/i).fill('alice@athlya.app');
  await page.getByLabel(/mot de passe|password/i).fill('Password1234');
  await page.getByRole('button', { name: /se connecter|sign in/i }).click();
  await page.waitForURL('/classes');

  // Navigate to profile page — boot refresh fires again (stubbed).
  await page.goto('/me');

  // Wait for ProfileForm to hydrate with the seeded display name.
  const nameInput = page.locator('#profile-display-name');
  await expect(nameInput).toHaveValue('Alice');

  // Edit the display name.
  await nameInput.fill('Alice Updated');

  // Submit via the "Enregistrer les modifications" button — use the full
  // key text to avoid ambiguity with "Save my preferences" (ConsentsForm).
  await page.getByRole('button', { name: /enregistrer les modifications|save changes/i }).click();

  // Success banner must appear (Req 3.4).
  await expect(page.getByText(/profil mis à jour|profile updated/i)).toBeVisible();

  // PATCH must have fired exactly once with the correct payload.
  expect(patchCalls).toHaveLength(1);
  const patchBody = patchCalls[0]?.postDataJSON() as { displayName?: string };
  expect(patchBody.displayName).toBe('Alice Updated');
});

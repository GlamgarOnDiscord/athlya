/**
 * Playwright fixture: log in a test user without hitting a real API.
 *
 * The Athlya web app stores the access token in memory (see
 * `apps/web/src/lib/auth/token-store.ts`) and gates authenticated
 * pages behind `<RequireAuth>`. For an accessibility sweep we do
 * not care about the correctness of the login flow itself — we just
 * need `/classes`, `/me`, `/me/export`, `/me/delete` to render their
 * authenticated state so axe can analyse the DOM.
 *
 * Strategy:
 *  1. Stub `POST /api/auth/login` to return a fake `accessToken`.
 *  2. Stub the downstream reads (`/v1/members/me`, `/v1/classes`) so
 *     the authenticated pages render without 401/500 noise that
 *     would pollute the axe report with error-state markup.
 *  3. Submit the real login form so the client-side token store is
 *     populated exactly the way a human login would populate it —
 *     `RequireAuth` will then let us navigate freely.
 *
 * @see Requirements 27.1, 27.2.
 */
import type { Page } from '@playwright/test';

export async function loginWithStub(page: Page): Promise<void> {
    // Intercept the login proxy and return a fake session.
    await page.route('**/api/auth/login', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accessToken: 'fake-access-token',
                accessTokenExpiresIn: 900,
                user: {
                    id: 'user-1',
                    email: 'test@athlya.app',
                    displayName: 'Test',
                },
            }),
        });
    });

    // Stub the profile read so `/me` renders its populated state.
    await page.route('**/v1/members/me', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: 'user-1',
                email: 'test@athlya.app',
                displayName: 'Test',
                avatarUrl: null,
                consents: {
                    marketing: false,
                    analytics: false,
                    thirdParty: false,
                    version: '2026-01',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            }),
        });
    });

    // Stub the classes list so `/classes` renders the empty-state
    // markup instead of a loading spinner when axe runs.
    await page.route('**/v1/classes*', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ items: [] }),
        });
    });

    // Walk the real form so the client-side token store is
    // populated exactly as a human login would populate it.
    await page.goto('/login');
    await page.getByLabel(/adresse e-mail|email/i).fill('test@athlya.app');
    await page.getByLabel(/mot de passe|password/i).fill('Password1234');
    await page
        .getByRole('button', { name: /se connecter|sign in/i })
        .click();
    await page.waitForURL('/');
}

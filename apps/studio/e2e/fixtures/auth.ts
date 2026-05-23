import type { Page } from '@playwright/test';

const FAKE_TOKEN = 'fake-admin-token';

const FAKE_USER = {
  id: 'admin-1',
  email: 'admin@athlya.app',
  displayName: 'Admin Test',
  studioId: 'studio-1',
  role: 'admin' as const,
};

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.route('**/api/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accessToken: FAKE_TOKEN,
        accessTokenExpiresIn: 900,
        user: FAKE_USER,
      }),
    });
  });

  await page.route('**/v1/classes*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route('**/v1/members*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null, total: 0 }),
    });
  });

  await page.route('**/v1/studios/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'studio-1',
        name: 'Test Studio',
        logoUrl: null,
        primaryColor: '#000000',
        locale: 'fr',
      }),
    });
  });

  await page.route('**/v1/audit*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });

  await page.route('**/v1/billing/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
  });

  await page.route('**/v1/checkins*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        reservationId: 'res-1',
        member: { id: 'member-1', displayName: 'Test Member', avatarUrl: null },
      }),
    });
  });
}

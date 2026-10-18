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

  await page.route('**/v1/programs*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '0b000000-0000-4000-8000-000000000001',
            studioId: 'studio-1',
            title: 'Strength 101',
            description: null,
            status: 'published',
            version: 0,
            weekCount: 4,
            createdAt: '2026-10-01T08:00:00.000Z',
            updatedAt: '2026-10-01T08:00:00.000Z',
            archivedAt: null,
          },
          {
            id: '0b000000-0000-4000-8000-000000000002',
            studioId: 'studio-1',
            title: 'Mobility draft',
            description: null,
            status: 'draft',
            version: 0,
            weekCount: 2,
            createdAt: '2026-10-02T08:00:00.000Z',
            updatedAt: '2026-10-02T08:00:00.000Z',
            archivedAt: null,
          },
        ],
      }),
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

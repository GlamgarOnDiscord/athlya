/**
 * Playwright fixture: open an authenticated page without a real API.
 *
 * The Athlya web app stores the access token in memory (see
 * `apps/web/src/lib/auth/token-store.ts`) and gates authenticated
 * pages behind `<RequireAuth>`. Every `page.goto` reloads the app and
 * drops that token, so `<AuthProvider>` runs the boot silent refresh
 * (`POST /api/auth/refresh`). Without a refresh cookie it fails and
 * `<RequireAuth>` redirects to `/login` — an axe scan would then
 * analyse the login form instead of the page under test.
 *
 * Strategy:
 *  1. Stub the boot refresh so the session is restored on load.
 *  2. Stub the member API reads (`/v1/members/me`, `/v1/classes`,
 *     `/v1/me/progression`, `/v1/me/progression/cardio`, `/v1/coach`,
 *     `/v1/calendar/feed-url`, `/v1/reservations/me`, `/v1/checkins/token`) so
 *     the authenticated pages render their populated state instead of loading or error markup.
 *  3. Wait for a locator that only exists inside the page's
 *     `<RequireAuth>` subtree and check the URL did not move, so a
 *     silent redirect to `/login` fails the test before axe runs.
 *
 * @see Requirements 27.1, 27.2.
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';

/**
 * `hour`:00 UTC tomorrow. The classes page shows a strip of days from
 * today, so the class stubs must stay in the future whenever the suite runs.
 */
function tomorrowAt(hour: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCHours(hour, 0, 0, 0);
  return day.toISOString();
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Make the boot silent refresh restore a session on every page load. */
export async function stubBootRefresh(page: Page): Promise<void> {
  await page.route('**/api/auth/refresh', (route) =>
    fulfillJson(route, { accessToken: 'fake-access-token', accessTokenExpiresIn: 900 }),
  );
}

/** Stub the member API reads the authenticated pages render from. */
export async function stubMemberApi(page: Page): Promise<void> {
  await page.route('**/v1/members/me', (route) =>
    fulfillJson(route, {
      id: 'user-1',
      email: 'test@athlya.app',
      displayName: 'Test',
      avatarUrl: null,
      consents: {
        marketing: false,
        analytics: false,
        // Matches the coach status stub below (thirdPartyConsent: true).
        thirdParty: true,
        version: '2026-01',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );

  // One bookable class and one full class, so both the booking and
  // the waitlist call-to-action are part of the scan.
  await page.route('**/v1/classes*', (route) =>
    fulfillJson(route, {
      items: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          studioId: '00000000-0000-4000-8000-0000000000aa',
          coachId: null,
          title: 'Morning yoga',
          startsAt: tomorrowAt(7),
          durationMin: 60,
          capacity: 12,
          version: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          remaining: 5,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          studioId: '00000000-0000-4000-8000-0000000000aa',
          coachId: null,
          title: 'Evening HIIT',
          startsAt: tomorrowAt(18),
          durationMin: 45,
          capacity: 10,
          version: 0,
          createdAt: '2026-10-01T00:00:00.000Z',
          remaining: 0,
        },
      ],
    }),
  );

  // No booking yet: `/classes` offers every class and `/me` shows the
  // empty "upcoming bookings" state with its call to action.
  await page.route('**/v1/reservations/me*', (route) =>
    fulfillJson(route, { items: [], nextCursor: null }),
  );

  await page.route('**/v1/me/progression*', (route) =>
    fulfillJson(route, {
      windowDays: 90,
      from: '2026-07-18T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
      totals: { sessions: 2, volumeKg: 1860 },
      exercises: [
        {
          key: 'back squat',
          name: 'Back squat',
          sessionCount: 2,
          totalVolumeKg: 1860,
          bestEstimatedOneRepMaxKg: 130,
          points: [
            { date: '2026-10-01', volumeKg: 960, estimatedOneRepMaxKg: 130 },
            { date: '2026-10-08', volumeKg: 900, estimatedOneRepMaxKg: 125 },
          ],
        },
      ],
      weeklyFrequency: [
        { weekStart: '2026-09-28', sessions: 1 },
        { weekStart: '2026-10-05', sessions: 1 },
        { weekStart: '2026-10-12', sessions: 0 },
      ],
      truncated: false,
      skippedSessions: 0,
    }),
  );

  await page.route('**/v1/me/progression/cardio*', (route) =>
    fulfillJson(route, {
      windowDays: 90,
      from: '2026-07-18T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
      bucket: 'week',
      totals: { sessions: 2, durationSec: 4500, distanceM: 12500, energyKcal: 500 },
      machines: [
        {
          machine: 'rower',
          sessionCount: 2,
          totals: { durationSec: 4500, distanceM: 12500, energyKcal: 500 },
          series: [
            {
              periodStart: '2026-09-28',
              sessions: 1,
              durationSec: 2400,
              distanceM: 6000,
              energyKcal: 260,
              avgPowerW: 180,
              avgHeartRateBpm: 140,
            },
            {
              periodStart: '2026-10-05',
              sessions: 1,
              durationSec: 2100,
              distanceM: 6500,
              energyKcal: 240,
              avgPowerW: 190,
              avgHeartRateBpm: 142,
            },
            {
              periodStart: '2026-10-12',
              sessions: 0,
              durationSec: 0,
              distanceM: 0,
              energyKcal: 0,
              avgPowerW: null,
              avgHeartRateBpm: null,
            },
          ],
          points: [
            {
              startedAt: '2026-10-01T07:00:00.000Z',
              durationSec: 2400,
              distanceM: 6000,
              avgPowerW: 180,
              avgSpeedKmh: 9,
              avgHeartRateBpm: 140,
            },
            {
              startedAt: '2026-10-08T07:00:00.000Z',
              durationSec: 2100,
              distanceM: 6500,
              avgPowerW: 190,
              avgSpeedKmh: 11.1,
              avgHeartRateBpm: 142,
            },
          ],
        },
      ],
      truncated: false,
      skippedSessions: 0,
    }),
  );

  // Calendar block on `/me` (issue #719): the subscription URL and one
  // upcoming confirmed booking, so the copy control and the "add to
  // calendar" links are part of the scan.
  await page.route('**/v1/calendar/feed-url', (route) =>
    fulfillJson(route, {
      httpsUrl: 'https://api.athlya.test/v1/calendar/feed.ics?token=e2e.token',
      webcalUrl: 'webcal://api.athlya.test/v1/calendar/feed.ics?token=e2e.token',
    }),
  );
  await page.route('**/v1/reservations/me*', (route) =>
    fulfillJson(route, {
      items: [
        {
          id: 'reservation-1',
          classId: 'class-1',
          userId: 'user-1',
          status: 'confirmed',
          createdAt: '2026-10-01T09:00:00.000Z',
          cancelledAt: null,
          checkedInAt: null,
          class: {
            id: 'class-1',
            title: 'Morning Yoga',
            startsAt: '2030-01-07T08:00:00.000Z',
            durationMin: 60,
          },
        },
      ],
      nextCursor: null,
    }),
  );

  // Check-in QR token so `/me/checkin` renders its code. The page only
  // encodes the opaque string, so it is deliberately not JWT-shaped.
  await page.route('**/v1/checkins/token', (route) =>
    fulfillJson(route, {
      token: 'e2e-checkin-token-not-a-jwt',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }),
  );

  // AI coach status (`ai-coach` flag on, consent granted) so `/me`
  // shows the coach link and `/me/coach` renders its form.
  await page.route('**/v1/coach', (route) =>
    fulfillJson(route, {
      enabled: true,
      thirdPartyConsent: true,
      quota: { limit: 10, remaining: 9, resetsAt: '2026-10-16T00:00:00.000Z' },
    }),
  );
}

/**
 * Open `path` as a signed-in member and wait until its authenticated
 * content rendered. `rendered` must target markup that only exists
 * inside the page's `<RequireAuth>` subtree: the server-rendered
 * `<h1>` sits outside the guard and shows up even when signed out.
 */
export async function openAuthenticatedPage(
  page: Page,
  path: string,
  rendered: Locator,
): Promise<void> {
  await stubBootRefresh(page);
  await stubMemberApi(page);
  await page.goto(path);
  await expect(rendered).toBeVisible();
  expect(new URL(page.url()).pathname, `${path} redirected away (to /login?)`).toBe(path);
}

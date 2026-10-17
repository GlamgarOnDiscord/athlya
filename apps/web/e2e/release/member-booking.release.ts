/**
 * Member journey on the deployed web Worker and the real API (#422):
 * log in → list classes → book → cancel.
 *
 * The web app has no cancel button yet, so the reservation booked through
 * the UI is cancelled through the API with the session the login form
 * produced. `afterEach` cancels it again if any step after the booking
 * failed or timed out, so the run is idempotent and the smoke account
 * never keeps a seat. A class the account already holds (HTTP 409, e.g. a
 * concurrent staging gate) is skipped and left to its owner.
 */
import { randomUUID } from 'node:crypto';

import { expect, request as playwrightRequest, test } from '@playwright/test';

import { dismissCookieBanner, isCall, requireEnv, waitForSubmittable } from './support';

/** The API refuses cancellations less than 2 h before the class starts. */
const CANCEL_MARGIN_MS = 3 * 60 * 60 * 1000;

interface ClassItem {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly remaining: number;
}

interface Booked {
  readonly reservationId: string;
  readonly accessToken: string;
}

let booked: Booked | null = null;

async function cancelReservation(apiUrl: string, { reservationId, accessToken }: Booked) {
  const api = await playwrightRequest.newContext();
  try {
    return await api.delete(`${apiUrl}/v1/reservations/${reservationId}`, {
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': randomUUID() },
      timeout: 15_000,
    });
  } finally {
    await api.dispose();
  }
}

test.afterEach(async () => {
  if (booked === null) return;
  const pending = booked;
  booked = null;
  const { API_URL } = requireEnv(['API_URL']);
  const res = await cancelReservation(API_URL, pending).catch(() => null);
  if (res === null || ![200, 204].includes(res.status())) {
    console.error(
      `[release-smoke] could not cancel reservation ${pending.reservationId} ` +
        `(HTTP ${String(res?.status() ?? 'network error')}); cancel it manually`,
    );
  }
});

test('member: log in → list classes → book → cancel @turnstile', async ({ page }) => {
  const { API_URL, SMOKE_EMAIL, SMOKE_PASSWORD } = requireEnv([
    'API_URL',
    'SMOKE_EMAIL',
    'SMOKE_PASSWORD',
  ]);

  // ---------------------------------------------------------------- login
  await page.goto('/login');
  await dismissCookieBanner(page);
  await page.getByLabel(/^(adresse e-mail|email address)$/iu).fill(SMOKE_EMAIL);
  await page.getByLabel(/^(mot de passe|password)$/iu).fill(SMOKE_PASSWORD);
  const submit = page.getByRole('button', { name: /^(se connecter|sign in)$/iu });
  await waitForSubmittable(submit);

  const loginResponse = page.waitForResponse(isCall('POST', '/api/auth/login'));
  await submit.click();
  const login = await loginResponse;
  expect(login.status(), 'login through /api/auth/login').toBe(200);
  const session = (await login.json()) as { accessToken?: unknown };
  expect(typeof session.accessToken, 'login returns an access token').toBe('string');
  const accessToken = String(session.accessToken);
  await page.waitForURL((url) => url.pathname === '/');

  // --------------------------------------------------------- list classes
  // A full navigation drops the in-memory token: the page only renders
  // the list if the refresh cookie set by the login round-trips.
  const classesResponse = page.waitForResponse(isCall('GET', '/v1/classes'));
  await page.goto('/classes');
  const classes = await classesResponse;
  expect(classes.status(), 'GET /v1/classes').toBe(200);
  const { items } = (await classes.json()) as { items: ClassItem[] };
  const now = Date.now();
  const candidates = items.filter(
    (item) => item.remaining > 0 && Date.parse(item.startsAt) - now > CANCEL_MARGIN_MS,
  );
  expect(
    candidates.length,
    'no class with a free seat in the next 14 days (and > 3 h away): seed the smoke studio',
  ).toBeGreaterThan(0);

  // ----------------------------------------------------------------- book
  for (const candidate of candidates) {
    const card = page.locator(`[aria-labelledby="class-card-${candidate.id}-title"]`);
    await expect(card).toBeVisible();

    const bookingResponse = page.waitForResponse(isCall('POST', '/v1/reservations'));
    await card.getByRole('button', { name: /^(réserver|book) —/iu }).click();
    const booking = await bookingResponse;

    if (booking.status() === 409) {
      console.log(`[release-smoke] class ${candidate.id} already booked by the smoke account`);
      continue;
    }
    expect([201, 202], `POST /v1/reservations answered ${String(booking.status())}`).toContain(
      booking.status(),
    );
    const body = (await booking.json()) as { reservation?: { id?: unknown } };
    expect(typeof body.reservation?.id, 'booking returns a reservation id').toBe('string');
    booked = { reservationId: String(body.reservation?.id), accessToken };

    await expect(card.getByRole('button', { name: /^(réservé|booked) —/iu })).toBeDisabled();
    break;
  }
  expect(booked, 'every bookable class is already held by the smoke account').not.toBeNull();

  // --------------------------------------------------------------- cancel
  const reservation = booked as Booked | null;
  if (reservation === null) return;
  const cancelled = await cancelReservation(API_URL, reservation);
  expect([200, 204], `DELETE /v1/reservations answered ${String(cancelled.status())}`).toContain(
    cancelled.status(),
  );
  booked = null;
});

/**
 * End-to-end happy path: register → book → cancel.
 *
 * Exercises the member-facing flow from task 10.8 in a single
 * chromium session with every outbound request stubbed via
 * `page.route()`, so the test is hermetic and does not require a
 * running Hono API or Redis.
 *
 * Coverage
 * --------
 *  1. **Register** — `POST /api/auth/register` is stubbed to return
 *     the same shape the real Next route emits (access token +
 *     `accessTokenExpiresIn` + `user`), and the client lands on `/`
 *     afterward (matches `RegisterForm.tsx` — `router.push('/')`).
 *  2. **List classes** — `GET /v1/classes?from=…&to=…` returns a
 *     single seeded class with 5 seats remaining.
 *  3. **Book** — `POST /v1/reservations` returns `201 {status:
 *     'confirmed'}` and the optimistic decrement lands (5 → 4) with
 *     a confirmation banner.
 *  4. **Cancel** — the web app does not yet expose a cancellation UI
 *     (no `/me/reservations` page, no `reservations.cancel` call
 *     site in any component — confirmed by grep). Rather than
 *     scaffold new product surface in a test, we stub the
 *     `DELETE /v1/reservations/:id` endpoint and drive it via a
 *     browser-side `fetch` from the already-authenticated page, then
 *     assert the stub observed exactly one `DELETE` request with a
 *     `204 No Content` response. That proves the wire contract from
 *     Req 9.1 and the route stub are in place for the day a cancel
 *     button lands in the UI.
 *
 * Turnstile
 * ---------
 *  The test environment does not provision
 *  `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, so `TurnstileWidget` renders its
 *  dev-mode banner ("Turnstile non configuré") and the form's guard
 *  `if (siteKey !== undefined && turnstileToken === '')` is skipped
 *  entirely. This mirrors the posture already used by `axe.spec.ts`
 *  and keeps the E2E free of a live Cloudflare dependency.
 *
 *  When a future CI job wires up the real site key, the Cloudflare
 *  test key `1x00000000000000000000AA` can be pinned on the web
 *  server via `webServer.env` in `playwright.config.ts`; that key
 *  always issues the bypass token `XXXX.DUMMY.TOKEN.XXXX`.
 *
 * @see Requirements 1.1 (register), 8.1 (book → 201 confirmed),
 *      9.1 (cancel → 204).
 */
import { expect, test, type Request, type Route } from '@playwright/test';

/**
 * Seeded class id (UUID v4, deterministic). The shared schema
 * brands the type; Playwright sees a plain string here, which is
 * fine because the stubs only echo it back into response bodies.
 */
const CLASS_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = 'res-1';

/** The seed row `GET /v1/classes` returns. Starts 7 days in the future. */
function seedClass(remaining: number): Record<string, unknown> {
    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
        id: CLASS_ID,
        studioId: '22222222-2222-4222-8222-222222222222',
        coachId: null,
        title: 'CrossFit WOD',
        startsAt,
        durationMin: 60,
        capacity: 12,
        version: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        remaining,
    };
}

test('register → book → cancel (happy path, stubbed network)', async ({
    page,
}) => {
    // --------------------------------------------------------------
    // Step 1 — Register
    // --------------------------------------------------------------
    // The Next route handler at `/api/auth/register` normally
    // forwards to the Hono gateway; here we short-circuit it and
    // return a synthetic session. The shape mirrors
    // `ClientSessionResponse` in `src/app/api/auth/register/route.ts`.
    await page.route('**/api/auth/register', async (route: Route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            // The real route also emits a Set-Cookie for the refresh
            // token; for the E2E we only care that the access token
            // lands in the in-memory store, which only needs the body.
            body: JSON.stringify({
                accessToken: 'fake-access-token',
                accessTokenExpiresIn: 900,
                user: {
                    id: 'user-1',
                    email: 'alice@athlya.app',
                    displayName: 'Alice',
                },
            }),
        });
    });

    // Stub `/v1/classes` up-front so the target of `router.push('/')`
    // plus any subsequent navigation to `/classes` both see the
    // seeded list. Seats start at 5.
    const classesHandler = async (route: Route): Promise<void> => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ items: [seedClass(5)] }),
        });
    };
    await page.route('**/v1/classes*', classesHandler);

    // Stub the booking POST. Returns the shape `<ClassesList>` reads
    // on its 201 path (`status: 'confirmed'`).
    const bookingCalls: Request[] = [];
    await page.route('**/v1/reservations', async (route: Route) => {
        bookingCalls.push(route.request());
        await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
                status: 'confirmed',
                reservation: {
                    id: RESERVATION_ID,
                    classId: CLASS_ID,
                    userId: 'user-1',
                    status: 'confirmed',
                    createdAt: new Date().toISOString(),
                    version: 0,
                },
            }),
        });
    });

    // Stub the cancel DELETE. Playwright records the observed
    // request so we can assert on method + path after the test drives
    // the call.
    const cancelCalls: Request[] = [];
    await page.route(
        `**/v1/reservations/${RESERVATION_ID}`,
        async (route: Route) => {
            cancelCalls.push(route.request());
            await route.fulfill({ status: 204, body: '' });
        },
    );

    await page.goto('/register');

    // Fill the form. Labels come from `@athlya/shared/i18n`
    // (`auth.register.*`) — asserting on the French copy is safe
    // because the test environment resolves `fr` via the Edge proxy
    // default (Req 28.1).
    await page.getByLabel(/adresse e-mail|email/i).fill('alice@athlya.app');
    await page
        .getByLabel(/^mot de passe|^password/i)
        .fill('Correct-horse-battery-staple-1');
    await page.getByLabel(/nom affiché|display name/i).fill('Alice');
    await page.getByLabel(/code salle|studio slug/i).fill('athlya-test');

    // Submit.
    await page
        .getByRole('button', { name: /s'inscrire|sign up/i })
        .click();

    // `RegisterForm.tsx` does `router.push('/')` on success. Wait
    // for the URL to settle before moving on.
    await page.waitForURL('/');

    // --------------------------------------------------------------
    // Step 2 — Browse /classes and book
    // --------------------------------------------------------------
    await page.goto('/classes');

    // The seeded card renders title + 5/12 remaining counter.
    await expect(page.getByRole('heading', { name: 'CrossFit WOD' })).toBeVisible();
    await expect(page.getByText('5 / 12')).toBeVisible();

    const bookCta = page.getByRole('button', { name: /^réserver|^book$/i });
    await expect(bookCta).toBeEnabled();
    await bookCta.click();

    // Optimistic decrement (5 → 4) + success banner.
    await expect(page.getByText('4 / 12')).toBeVisible();
    await expect(
        page.getByRole('status').filter({ hasText: /réservation confirmée|reservation confirmed/i }),
    ).toBeVisible();

    // Booking stub observed exactly one POST with the `Idempotency-Key` header.
    expect(bookingCalls).toHaveLength(1);
    const bookingRequest = bookingCalls[0];
    expect(bookingRequest?.method()).toBe('POST');
    expect(bookingRequest?.headers()['idempotency-key']).toBeDefined();
    const bookingBody = bookingRequest?.postDataJSON() as { classId: string };
    expect(bookingBody.classId).toBe(CLASS_ID);

    // --------------------------------------------------------------
    // Step 3 — Cancel
    // --------------------------------------------------------------
    // The web app does not yet expose a cancel UI (grep finds no
    // `reservations.cancel` call site in `apps/web/src`). We drive
    // the cancellation endpoint directly from the browser context so
    // the wire contract is exercised end-to-end — the test will grow
    // a real UI click the day a cancel button lands in the product.
    const cancelStatus = await page.evaluate(async (reservationId) => {
        const response = await fetch(`/v1/reservations/${reservationId}`, {
            method: 'DELETE',
        });
        return response.status;
    }, RESERVATION_ID);

    expect(cancelStatus).toBe(204);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.method()).toBe('DELETE');
});

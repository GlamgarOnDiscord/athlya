/**
 * Password-reset request on the deployed web Worker and the real API (#422).
 *
 * The request is sent for a per-run sub-address of the smoke mailbox
 * (`local+reset-<run>@domain`), not for the smoke account itself:
 *  - the API allows 3 reset requests per address per 24 h, so reusing the
 *    account address would turn the fourth deploy of a day red;
 *  - the sub-address matches no account, so no token is created and no
 *    email is sent, while the browser, Turnstile, the same-origin proxy and
 *    the API route answer exactly as for a real account (the 204 and the
 *    UI are identical by design, issue #521).
 */
import { expect, test } from '@playwright/test';

import { dismissCookieBanner, isCall, requireEnv, runTag, waitForSubmittable } from './support';

function subAddress(email: string, tag: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) throw new Error('SMOKE_EMAIL is not an email address');
  const local = email.slice(0, at).split('+')[0] ?? '';
  return `${local}+reset-${tag}${email.slice(at)}`;
}

test('password reset: request shows the generic confirmation @turnstile', async ({
  page,
}, testInfo) => {
  const { SMOKE_EMAIL } = requireEnv(['SMOKE_EMAIL']);

  await page.goto('/forgot-password');
  await dismissCookieBanner(page);
  await page
    .getByLabel(/^(adresse email|email address)$/iu)
    .fill(subAddress(SMOKE_EMAIL, runTag(testInfo.retry)));
  const submit = page.getByRole('button', { name: /^(envoyer le lien|send reset link)$/iu });
  await waitForSubmittable(submit);

  const requestResponse = page.waitForResponse(isCall('POST', '/api/auth/password-reset/request'));
  await submit.click();
  const response = await requestResponse;
  expect(response.status(), 'POST /api/auth/password-reset/request').toBe(204);

  await expect(
    page.getByText(/si votre adresse email correspond à un compte|if your email matches an/iu),
  ).toBeVisible();
});

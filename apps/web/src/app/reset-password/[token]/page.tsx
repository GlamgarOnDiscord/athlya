/**
 * `/reset-password/[token]` — Sprint 8 / SP7.5 (Vague 36).
 *
 * Server component shell. The form (token consumption + new
 * password capture) lives in the client component
 * `./ResetPasswordForm.tsx`.
 *
 * The token in the URL path is the plain reset-token minted by
 * `requestReset`. It travels in the URL ONLY in the email link
 * the user clicks; once on this page, the form posts the token +
 * new password as a JSON body to `POST /api/auth/password-reset/confirm`.
 *
 * On success the API returns 204 and the form redirects to
 * `/login` with a flash banner (handled client-side).
 */
import { headers } from 'next/headers';

import { getLocale } from '../../../lib/i18n/getLocale';

import { ResetPasswordForm } from './ResetPasswordForm';

import type { ReactElement } from 'react';

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<ReactElement> {
  const [{ token }, h] = await Promise.all([params, headers()]);
  const nonce = h.get('x-nonce') ?? '';
  void (await getLocale());

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12"
    >
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Choisir un nouveau mot de passe</h1>
        <p className="text-sm text-muted-foreground">
          Une fois le mot de passe enregistré, toutes vos sessions actives seront fermées et vous
          devrez vous reconnecter.
        </p>
      </header>
      <ResetPasswordForm token={token} nonce={nonce} />
    </main>
  );
}

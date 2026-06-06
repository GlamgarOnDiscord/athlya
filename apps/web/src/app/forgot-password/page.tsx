/**
 * `/forgot-password` — Sprint 8 / SP7.5 (Vague 36) finalises
 * audit finding S2-006 user-facing surface.
 *
 * Server component shell — pattern identique à `/login` et
 * `/register`. La logique de soumission (`POST /api/auth/password-reset/request`)
 * vit dans `./ForgotPasswordForm.tsx` (client component) parce
 * qu'elle a besoin de gérer un état React + le challenge Turnstile.
 *
 * Layout :
 *   1. Titre + sous-titre rappelant le flow.
 *   2. Champ email.
 *   3. Bouton soumission.
 *   4. Lien retour vers `/login`.
 *
 * Posture sécurité :
 *   - La route API renvoie 204 unconditionnellement (email-enumeration
 *     defence). Le formulaire affiche TOUJOURS le même message de
 *     succès quel que soit le résultat — l'utilisateur ne sait pas
 *     si l'email existe.
 */
import { headers } from 'next/headers';
import Link from 'next/link';

import { getLocale } from '../../lib/i18n/getLocale';

import { ForgotPasswordForm } from './ForgotPasswordForm';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = {
  title: 'Réinitialiser le mot de passe',
  description: 'Demandez un lien de réinitialisation de mot de passe.',
};

export default async function ForgotPasswordPage(): Promise<ReactElement> {
  const h = await headers();
  const nonce = h.get('x-nonce') ?? '';
  void (await getLocale());

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12"
    >
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Mot de passe oublié</h1>
        <p className="text-sm text-muted-foreground">
          Saisissez l&apos;adresse email de votre compte. Si elle correspond à un compte actif, nous
          vous enverrons un lien de réinitialisation valide pendant 1 heure.
        </p>
      </header>
      <ForgotPasswordForm nonce={nonce} />
      <p className="text-center text-sm">
        <Link href="/login" className="underline">
          Retour à la connexion
        </Link>
      </p>
    </main>
  );
}

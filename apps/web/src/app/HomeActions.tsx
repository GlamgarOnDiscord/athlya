/**
 * Landing-page call-to-action strip, auth-aware.
 *
 * Split out of `page.tsx` (which stays a Server Component for the
 * shell + locale resolution) so this piece can read the in-memory
 * access token via `useAuth()` and swap the CTAs depending on the
 * session state:
 *
 *   - Signed out → `Créer un compte` + `Se connecter`.
 *   - Signed in  → `Voir les cours` + `Mon compte` + `Se déconnecter`.
 *
 * The access token lives only in memory (see
 * `src/lib/auth/token-store.ts`), so the first paint is always
 * "signed out" and the component swaps to "signed in" once the
 * `AuthProvider` hydrates. Acceptable for a landing page — heavier
 * routes (`/me`, `/classes`) gate themselves via their own checks.
 *
 * Strings resolve through `createTranslator(locale)` — the parent
 * Server Component passes `locale` as a prop so this component never
 * needs to re-parse the `Accept-Language` header client-side.
 *
 * @see Req 25.3 (CSP-strict client component), Req 28.1 (i18n).
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

export function HomeActions(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { refresh } = useRouter();
  const { isAuthenticated, bootResolved, logout } = useAuth();

  const onLogout = useCallback(async () => {
    await logout();
    refresh();
  }, [logout, refresh]);

  if (!bootResolved) {
    return (
      <div className="flex flex-wrap justify-center gap-4">
        <Skeleton className="h-10 w-36" />
        <Skeleton className="h-10 w-32" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-wrap justify-center gap-4">
        <Link className={buttonVariants()} href="/register">
          {t('web.home.register')}
        </Link>
        <Link className={buttonVariants({ variant: 'outline' })} href="/login">
          {t('web.home.login')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap justify-center gap-4">
      <Link className={buttonVariants()} href="/classes">
        {t('web.home.classes')}
      </Link>
      <Link className={buttonVariants({ variant: 'outline' })} href="/me">
        {t('web.home.me')}
      </Link>
      <Button
        variant="ghost"
        onClick={() => {
          void onLogout();
        }}
      >
        {t('web.home.logout')}
      </Button>
    </div>
  );
}

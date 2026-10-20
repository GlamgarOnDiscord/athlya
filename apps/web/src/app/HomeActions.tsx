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
 * `AuthProvider` hydrates. Acceptable for a landing page: heavier
 * routes (`/me`, `/classes`) gate themselves via their own checks.
 *
 * Strings resolve through `createTranslator(locale)`, with the locale
 * read from `LocaleContext`, so this component never re-parses the
 * `Accept-Language` header client-side. The landing renders it twice
 * (hero and closing call to action) at its display size; `className`
 * lets each placement set its own alignment.
 *
 * @see Req 25.3 (CSP-strict client component), Req 28.1 (i18n).
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

/**
 * Landing call-to-action size: 44 px tall, base text, semibold. Merged with
 * `cn` so the size and border utilities replace the variant's own instead
 * of competing with them (`cva` does not dedupe Tailwind classes).
 */
const CTA = 'h-11 px-5 text-base font-semibold';
const PRIMARY = cn(buttonVariants(), CTA);
/** The outline border reads the field boundary token, visible on ink. */
const OUTLINE = cn(buttonVariants({ variant: 'outline' }), CTA, 'border-input');

export function HomeActions({ className }: { readonly className?: string }): ReactElement {
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
      <div className={cn('flex flex-wrap gap-3', className)}>
        <Skeleton className="h-11 w-40" />
        <Skeleton className="h-11 w-32" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className={cn('flex flex-wrap gap-3', className)}>
        <Link className={PRIMARY} href="/register">
          {t('web.home.register')}
        </Link>
        <Link className={OUTLINE} href="/login">
          {t('web.home.login')}
        </Link>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap gap-3', className)}>
      <Link className={PRIMARY} href="/classes">
        {t('web.home.classes')}
      </Link>
      <Link className={OUTLINE} href="/me">
        {t('web.home.me')}
      </Link>
      <Button
        variant="ghost"
        className={CTA}
        onClick={() => {
          void onLogout();
        }}
      >
        {t('web.home.logout')}
      </Button>
    </div>
  );
}

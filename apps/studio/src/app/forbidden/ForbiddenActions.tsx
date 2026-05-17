/**
 * Client-side actions for the `/forbidden` page.
 *
 * Splits the auth-aware logout button out of the server component
 * shell so the page itself stays cleanly statically renderable.
 *
 * @see Requirement 6.5.
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';

import { useAuth } from '../../lib/auth/AuthContext';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator } from '../../lib/i18n/t';

export function ForbiddenActions(): ReactElement {
  const { push } = useRouter();
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { logout } = useAuth();

  const onLogout = useCallback(async () => {
    await logout();
    push('/login');
  }, [logout, push]);

  return (
    <div className="flex flex-wrap justify-center gap-3">
      <Button
        type="button"
        onClick={() => {
          void onLogout();
        }}
      >
        {t('studio.forbidden.signOut')}
      </Button>
      <Link href="/" className={buttonVariants({ variant: 'outline' })}>
        {t('web.error.home')}
      </Link>
    </div>
  );
}

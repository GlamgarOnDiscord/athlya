'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';

import { AthlyaLogo } from './AthlyaLogo';
import { LANDING_CONTAINER } from './landing/layout';
import { LocaleSwitcher } from './LocaleSwitcher';
import { MemberSidebar } from './MemberSidebar';

const MEMBER_AREA = ['/classes', '/me'] as const;

/** Whether `pathname` belongs to the signed-in member area. */
export function isMemberPath(pathname: string): boolean {
  return MEMBER_AREA.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

/**
 * Navigation for every page: the member area (`/classes`, `/me/*`) gets
 * the sidebar shell, public pages keep the top bar. A visitor known to be
 * signed out gets the top bar too; while the session restores, the
 * member shell stays so a signed-in reload does not flicker.
 */
export function AppNav({ children }: { readonly children: ReactNode }): ReactElement {
  const pathname = usePathname();
  const { isAuthenticated, bootResolved } = useAuth();
  const signedOut = bootResolved && !isAuthenticated;
  if (isMemberPath(pathname) && !signedOut) return <MemberSidebar>{children}</MemberSidebar>;
  return (
    <>
      <PublicTopBar />
      {children}
    </>
  );
}

/**
 * The public top bar. On the landing (`/`) it joins the page's dark scope
 * (`.landing-dark`) and its wider column, so the bar reads as part of the
 * page whatever the theme.
 */
function PublicTopBar(): ReactElement {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { refresh } = useRouter();
  const { isAuthenticated, bootResolved, logout } = useAuth();

  const onLogout = useCallback(async () => {
    await logout();
    refresh();
  }, [logout, refresh]);

  function navLink(href: string, label: string) {
    const isActive = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        className={cn(
          'whitespace-nowrap text-sm transition-colors',
          isActive
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        aria-current={isActive ? 'page' : undefined}
      >
        {label}
      </Link>
    );
  }

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full border-b border-border',
        isLanding
          ? 'landing-dark bg-background'
          : 'bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60',
      )}
    >
      <a
        href="#main-content"
        className="absolute left-4 top-0 z-50 -translate-y-full rounded-b-md bg-background px-4 py-2 text-sm font-medium text-foreground transition-transform focus:translate-y-0 focus:ring-2 focus:ring-ring"
      >
        {t('common.skipToContent')}
      </a>
      <nav
        className={cn(
          'flex items-center justify-between py-3',
          isLanding ? LANDING_CONTAINER : 'mx-auto max-w-3xl px-6',
        )}
        aria-label={t('common.nav.main')}
      >
        <Link href="/" aria-label={t('common.appName')} className="shrink-0 text-foreground">
          {/* The full lockup needs about 150 px; phones get the mascot alone. */}
          <AthlyaLogo height={24} className="hidden sm:block" />
          <AthlyaLogo variant="mascot" height={28} className="sm:hidden" />
        </Link>

        <div className="flex items-center gap-3 sm:gap-4">
          {!bootResolved ? (
            <>
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-16" />
            </>
          ) : isAuthenticated ? (
            <>
              {navLink('/classes', t('web.home.classes'))}
              {navLink('/me', t('web.home.me'))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="whitespace-nowrap"
                onClick={() => {
                  void onLogout();
                }}
              >
                {t('auth.logout')}
              </Button>
            </>
          ) : (
            <>
              {navLink('/login', t('auth.login.title'))}
              {navLink('/register', t('auth.register.title'))}
            </>
          )}
          <LocaleSwitcher />
        </div>
      </nav>
    </header>
  );
}

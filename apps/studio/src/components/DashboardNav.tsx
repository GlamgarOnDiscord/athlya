'use client';

import {
  BookOpenIcon,
  CalendarBlankIcon,
  CreditCardIcon,
  ListBulletsIcon,
  PaletteIcon,
  ScanIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../lib/i18n/t';

import { AthlyaLogo } from './AthlyaLogo';
import { isCoachRoute } from './RequireAdmin';
import { SidebarAction, SidebarShell } from './sidebar/Sidebar';

import type { SidebarSection } from './sidebar/nav-model';

/** Navigation of the studio console; every link is an existing route. */
export function studioSections(t: Translator): SidebarSection[] {
  return [
    {
      id: 'main',
      items: [
        {
          kind: 'link',
          href: '/dashboard',
          label: t('studio.nav.dashboard'),
          icon: SquaresFourIcon,
          match: 'exact',
        },
        {
          kind: 'link',
          href: '/dashboard/classes',
          label: t('studio.nav.classes'),
          icon: CalendarBlankIcon,
        },
        {
          kind: 'link',
          href: '/dashboard/programs',
          label: t('studio.nav.programs'),
          icon: BookOpenIcon,
        },
        {
          kind: 'link',
          href: '/dashboard/members',
          label: t('studio.nav.members'),
          icon: UsersIcon,
        },
        {
          kind: 'link',
          href: '/dashboard/checkin',
          label: t('studio.nav.checkin'),
          icon: ScanIcon,
        },
      ],
    },
    {
      id: 'settings',
      items: [
        {
          kind: 'group',
          id: 'settings',
          label: t('studio.nav.settings'),
          icon: SlidersHorizontalIcon,
          children: [
            {
              kind: 'link',
              href: '/dashboard/branding',
              label: t('studio.nav.branding'),
              icon: PaletteIcon,
            },
            {
              kind: 'link',
              href: '/dashboard/billing',
              label: t('studio.nav.billing'),
              icon: CreditCardIcon,
            },
            {
              kind: 'link',
              href: '/dashboard/audit',
              label: t('studio.nav.audit'),
              icon: ListBulletsIcon,
            },
          ],
        },
      ],
    },
  ];
}

/** A coach only reaches the kiosk, so only its links are kept (groups drop out). */
export function coachSections(sections: readonly SidebarSection[]): SidebarSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.kind === 'link' && isCoachRoute(item.href)),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Shell of `/dashboard/*`: collapsible sidebar on desktop, drawer on
 * mobile, signed-in admin and sign out at the bottom.
 */
export function DashboardNav({ children }: { readonly children: ReactNode }): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { user, logout } = useAuth();
  const { push } = useRouter();

  const onLogout = useCallback(async () => {
    await logout();
    push('/login');
  }, [logout, push]);

  const isCoach = user?.role === 'coach';
  const sections = useMemo(
    () => (isCoach ? coachSections(studioSections(t)) : studioSections(t)),
    [t, isCoach],
  );

  return (
    <SidebarShell
      sections={sections}
      labels={{
        navigation: t('common.nav.main'),
        collapse: t('common.nav.collapse'),
        expand: t('common.nav.expand'),
        openMenu: t('common.nav.openMenu'),
        closeMenu: t('common.nav.closeMenu'),
        menu: t('common.nav.menu'),
        skipToContent: t('common.skipToContent'),
      }}
      brand={
        <Link
          href="/dashboard"
          aria-label={t('studio.nav.brand')}
          className="rounded-md px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <AthlyaLogo height={20} />
        </Link>
      }
      renderFooter={(collapsed) => (
        <div className="flex flex-col gap-1">
          {user !== null && !collapsed ? (
            <div className="flex min-w-0 flex-col px-2.5 pb-1">
              <span className="truncate text-sm font-medium text-foreground">
                {user.displayName}
              </span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          ) : null}
          <SidebarAction
            icon={SignOutIcon}
            label={t('auth.logout')}
            collapsed={collapsed}
            onClick={() => {
              void onLogout();
            }}
          />
        </div>
      )}
    >
      {children}
    </SidebarShell>
  );
}

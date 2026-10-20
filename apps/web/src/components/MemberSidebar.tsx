'use client';

import {
  CalendarBlankIcon,
  ChartLineUpIcon,
  ChatCircleIcon,
  DownloadSimpleIcon,
  SignOutIcon,
  TrashIcon,
  UserCircleIcon,
  UserIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

import { useCoachEnabled } from '../app/me/coach/use-coach-enabled';
import { useApiClient } from '../lib/api/use-api-client';
import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../lib/i18n/t';

import { AthlyaLogo } from './AthlyaLogo';
import { LocaleSwitcher } from './LocaleSwitcher';
import { SidebarAction, SidebarShell } from './sidebar/Sidebar';

import type { ApiClient } from '../lib/api/client';
import type { SidebarItem, SidebarSection } from './sidebar/nav-model';

/** Navigation of the signed-in member area; every link is an existing route. */
export function memberSections(t: Translator, coachEnabled: boolean): SidebarSection[] {
  const main: SidebarItem[] = [
    { kind: 'link', href: '/classes', label: t('web.nav.classes'), icon: CalendarBlankIcon },
    {
      kind: 'link',
      href: '/me/progression',
      label: t('web.nav.progression'),
      icon: ChartLineUpIcon,
    },
  ];
  if (coachEnabled) {
    main.push({ kind: 'link', href: '/me/coach', label: t('coach.link'), icon: ChatCircleIcon });
  }
  return [
    { id: 'main', items: main },
    {
      id: 'account',
      items: [
        {
          kind: 'group',
          id: 'account',
          label: t('web.home.me'),
          icon: UserCircleIcon,
          children: [
            {
              kind: 'link',
              href: '/me',
              label: t('profile.title'),
              icon: UserIcon,
              match: 'exact',
            },
            {
              kind: 'link',
              href: '/me/export',
              label: t('profile.dataExport'),
              icon: DownloadSimpleIcon,
            },
            {
              kind: 'link',
              href: '/me/delete',
              label: t('profile.deleteAccount'),
              icon: TrashIcon,
            },
          ],
        },
      ],
    },
  ];
}

export interface MemberSidebarProps {
  readonly children: ReactNode;
  /** Test seam: inject a fake API client instead of the real one. */
  readonly client?: ApiClient;
}

/** Shell of the member area: sidebar on desktop, drawer on mobile. */
export function MemberSidebar({ children, client: clientProp }: MemberSidebarProps): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const client = useApiClient(clientProp);
  const { isAuthenticated, logout } = useAuth();
  const { refresh } = useRouter();
  const coachEnabled = useCoachEnabled(client, isAuthenticated);

  const onLogout = useCallback(async () => {
    await logout();
    refresh();
  }, [logout, refresh]);

  const sections = useMemo(() => memberSections(t, coachEnabled), [t, coachEnabled]);

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
          href="/"
          aria-label={t('common.appName')}
          className="rounded-md px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <AthlyaLogo height={20} />
        </Link>
      }
      renderFooter={(collapsed) => (
        <div className="flex flex-col gap-1">
          {collapsed ? null : (
            <div className="px-1 pb-1">
              <LocaleSwitcher />
            </div>
          )}
          {isAuthenticated ? (
            <SidebarAction
              icon={SignOutIcon}
              label={t('auth.logout')}
              collapsed={collapsed}
              onClick={() => {
                void onLogout();
              }}
            />
          ) : null}
        </div>
      )}
    >
      {children}
    </SidebarShell>
  );
}

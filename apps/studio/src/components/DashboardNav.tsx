'use client';

import {
  BookOpenIcon,
  CalendarBlankIcon,
  CreditCardIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  PlusIcon,
  QuestionIcon,
  ScanIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Skeleton } from '@/components/ui/skeleton';

import { initials } from '../app/dashboard/members/members-view';
import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../lib/i18n/t';

import { AthlyaLogo } from './AthlyaLogo';
import { isCoachRoute } from './RequireAdmin';
import { CommandPalette } from './shell/CommandPalette';
import { ShortcutsDialog } from './shell/ShortcutsDialog';
import { StudioProvider, useStudio } from './shell/StudioProvider';
import { ThemeToggle } from './shell/ThemeToggle';
import { SearchButton, TopBar } from './shell/TopBar';
import { SidebarAction, SidebarShell } from './sidebar/Sidebar';

import type { CommandItem } from './shell/command-search';
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
          fullReload: true,
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

/** Label of the navigation link that owns `pathname`: the longest matching href. */
export function pageLabelFor(sections: readonly SidebarSection[], pathname: string): string | null {
  let best: { href: string; label: string } | null = null;
  for (const link of flattenLinks(sections)) {
    const owns = pathname === link.href || pathname.startsWith(`${link.href}/`);
    if (owns && (best === null || link.href.length > best.href.length)) best = link;
  }
  return best?.label ?? null;
}

function flattenLinks(sections: readonly SidebarSection[]): Array<{ href: string; label: string }> {
  return sections.flatMap((section) =>
    section.items.flatMap((item) =>
      item.kind === 'link'
        ? [{ href: item.href, label: item.label }]
        : item.children.map((child) => ({ href: child.href, label: child.label })),
    ),
  );
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * Shell of `/dashboard/*`: collapsible sidebar on desktop, drawer on
 * mobile, a top bar with the breadcrumb, the command palette (Cmd+K or
 * Ctrl+K) and the theme switch, and the signed-in user at the bottom.
 */
export function DashboardNav({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <StudioProvider>
      <DashboardShell>{children}</DashboardShell>
    </StudioProvider>
  );
}

function DashboardShell({ children }: { readonly children: ReactNode }): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { user, logout } = useAuth();
  const { push } = useRouter();
  const pathname = usePathname();
  const studio = useStudio();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const onLogout = useCallback(async () => {
    await logout();
    push('/login');
  }, [logout, push]);

  const isCoach = user?.role === 'coach';
  const sections = useMemo(
    () => (isCoach ? coachSections(studioSections(t)) : studioSections(t)),
    [t, isCoach],
  );
  const pages = useMemo<CommandItem[]>(
    () =>
      flattenLinks(sections).map((link) => ({
        id: `page-${link.href}`,
        kind: 'page',
        label: link.label,
        hint: '',
        href: link.href,
      })),
    [sections],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === '?' && !isTyping(event.target)) {
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openPalette = (): void => setPaletteOpen(true);
  const studioName = studio?.name ?? null;
  const canCreate = !isCoach;

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
      brandCollapsed={
        <Link
          href="/dashboard"
          aria-label={t('studio.nav.brand')}
          className="grid size-9 place-items-center rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <AthlyaLogo variant="mascot" height={28} />
        </Link>
      }
      brand={
        <Link
          href="/dashboard"
          aria-label={t('studio.nav.brand')}
          className="flex items-center gap-2 rounded-md px-1 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <AthlyaLogo height={16} />
          <span
            aria-hidden="true"
            className="rounded-md border border-sidebar-border px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium"
          >
            {t('studio.shell.studioBadge')}
          </span>
        </Link>
      }
      mobileActions={
        <>
          <button
            type="button"
            onClick={openPalette}
            aria-label={t('studio.shell.search')}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MagnifyingGlassIcon aria-hidden="true" className="size-5" />
          </button>
          <ThemeToggle t={t} />
        </>
      }
      renderHeader={(collapsed) =>
        collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <IconAction label={t('studio.shell.search')} onClick={openPalette}>
              <MagnifyingGlassIcon aria-hidden="true" className="size-[18px]" />
            </IconAction>
            {canCreate ? <QuickCreate label={t('studio.shell.newClass')} /> : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 rounded-lg border border-sidebar-border p-2">
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
              >
                {studioName === null ? '' : initials(studioName)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">
                {studioName ?? <Skeleton className="h-4 w-28" />}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <SearchButton
                onSearch={openPalette}
                t={t}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-sidebar-border px-2.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {canCreate ? <QuickCreate label={t('studio.shell.newClass')} /> : null}
            </div>
          </div>
        )
      }
      renderFooter={(collapsed) => (
        <div className="flex flex-col gap-1">
          <SidebarAction
            icon={QuestionIcon}
            label={t('studio.shell.help')}
            collapsed={collapsed}
            onClick={() => setHelpOpen(true)}
          />
          {user !== null && !collapsed ? (
            <div className="flex min-w-0 items-center gap-3 px-2.5 py-2">
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full border border-sidebar-border bg-muted text-xs font-medium"
              >
                {initials(user.displayName)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {user.displayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {t(`studio.members.role.${user.role}`)}
                </span>
              </span>
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
      <TopBar
        studioName={studioName}
        pageLabel={pageLabelFor(sections, pathname)}
        onSearch={openPalette}
        t={t}
      />
      {children}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        pages={pages}
        locale={locale}
        t={t}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} t={t} />
    </SidebarShell>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function QuickCreate({ label }: { readonly label: string }): ReactElement {
  return (
    <Link
      href="/dashboard/classes?new=1"
      aria-label={label}
      title={label}
      className="grid size-8 shrink-0 place-items-center rounded-lg border border-sidebar-border text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PlusIcon aria-hidden="true" className="size-4" />
    </Link>
  );
}

/**
 * Admin-protected layout for `/dashboard/*`.
 *
 * Wraps every dashboard segment in `<RequireAdmin>` so non-admins
 * never see the shell. The server-side gate (the API gateway's
 * `requireRole('admin')`) is the authoritative one — this client
 * gate is a UX shortcut.
 *
 * The layout itself renders a top nav with links to the slices
 * 12.B (classes), 12.C (members + branding), and 12.D (billing).
 * Until those slices land the links 404 cleanly via `not-found.tsx`
 * and the dashboard home (`/dashboard`) is the default landing.
 *
 * @see Requirements 6.5, 14.1.
 */
import Link from 'next/link';

import { DashboardNav } from '../../components/DashboardNav';
import { RequireAdmin } from '../../components/RequireAdmin';
import { getLocale } from '../../lib/i18n/getLocale';
import { createTranslator } from '../../lib/i18n/t';

import type { ReactNode } from 'react';

export default async function DashboardLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <RequireAdmin>
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 p-6">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          {t('common.skipToContent')}
        </a>
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <Link href="/dashboard" className="text-lg font-semibold">
            {t('studio.nav.brand')}
          </Link>
          <DashboardNav
            links={[
              { href: '/dashboard/classes', label: t('studio.nav.classes') },
              { href: '/dashboard/members', label: t('studio.nav.members') },
              { href: '/dashboard/branding', label: t('studio.nav.branding') },
              { href: '/dashboard/billing', label: t('studio.nav.billing') },
            ]}
          />
        </header>
        <main id="main-content">{children}</main>
      </div>
    </RequireAdmin>
  );
}

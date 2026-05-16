/**
 * Root layout for the Athlya studio admin app.
 *
 * Mirrors `apps/web/src/app/layout.tsx`:
 *   - declares `<html lang>` from the negotiated locale,
 *   - wraps the tree in `<LocaleProvider>` + `<AuthProvider>` so every
 *     descendant client component reads both contexts without
 *     prop-drilling,
 *   - renders a minimal footer with the locale switcher.
 *
 * The brand-color CSS comes from `src/styles/tokens.css` (auto-generated
 * from `@athlya/shared/tokens`); per-tenant overrides are wired in a
 * follow-up slice as part of Epic 15.2 once the studio resolves the
 * active studio's `brand_color`.
 *
 * @see Req 25.3, Req 25.4, Req 28.1, Req 28.2.
 */
import { Toaster } from '@/components/ui/sonner';

import { LocaleSwitcher } from '../components/LocaleSwitcher';
import { AuthProvider } from '../lib/auth/AuthContext';
import { getLocale } from '../lib/i18n/getLocale';
import { LocaleProvider } from '../lib/i18n/LocaleContext';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Geist } from 'next/font/google';

import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: 'Athlya Studio',
  description: "Console d'administration des studios Athlya.",
  openGraph: {
    title: 'Athlya Studio',
    description: "Console d'administration des studios Athlya.",
    type: 'website',
  },
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const locale = await getLocale();

  return (
    <html lang={locale} suppressHydrationWarning className={cn('font-sans', geist.variable)}>
      <body>
        <LocaleProvider locale={locale}>
          <AuthProvider>
            {children}
            <Toaster richColors position="top-right" />
            <footer className="mx-auto flex max-w-5xl items-center justify-end px-6 py-4 text-xs text-muted-foreground">
              <LocaleSwitcher />
            </footer>
          </AuthProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}

export type { Locale } from '@athlya/shared/i18n';

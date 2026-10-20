/**
 * Root layout for the Athlya member web app.
 *
 * Responsibilities:
 *  - Declare the HTML shell with the negotiated locale on `<html lang>`
 *    (Req 28.1 / 28.2 — the locale is resolved by the Edge proxy via
 *    the `x-locale` header and exposed here via `getLocale()`).
 *  - Wrap `{children}` in `<LocaleProvider>` so every descendant
 *    client component can read the locale through `useLocale()`
 *    without prop-drilling.
 *  - Mount `<LocaleSwitcher>` in a minimal footer slot so the user
 *    can always override the negotiated locale.
 *
 * NOTE on brand color CSS: default brand colors
 * (`--athlya-brand-primary`, `--athlya-brand-on-primary`, tints,
 * shades) are already emitted by `@athlya/shared/theme.css` — itself
 * generated from `packages/shared/src/tokens.ts` by the
 * `build:theme-css` script (P4.3). An earlier draft of this file
 * injected an inline `<style nonce>` block to bake the same tokens
 * into `<head>`, but that:
 *   1. duplicated the theme stylesheet verbatim for zero added value;
 *   2. collided with Next 16's automatic nonce-injection on inline
 *      styles — the server-rendered `nonce=""` stayed empty while
 *      the client applied the real per-request nonce, surfacing as
 *      a hydration mismatch warning on every load.
 *
 * Task 15.1 (tenant resolver) will re-introduce a nonce-aware inline
 * `<style>` override when the per-tenant brand color needs to kick
 * the theme defaults for a given studio — using the
 * `ServerInsertedHTML` component or the `app/head.tsx` slot so the
 * nonce is stamped at the same stage the browser sees the node.
 *
 * `suppressHydrationWarning` on `<html>` is kept because browser
 * extensions (LanguageTool, Grammarly) inject attributes on the
 * top-level element before React hydrates. React docs explicitly
 * recommend this attribute for that exact case.
 *
 * @see Req 25.3, Req 25.4, Req 28.1, Req 28.2, Req 28.3.
 */
import { Toaster } from '@/components/ui/sonner';

import { AppNav } from '../components/AppNav';
import { CookieBanner } from '../components/CookieBanner';
import { JsonLd } from '../components/JsonLd';
import { ThemeProvider } from '../components/ThemeProvider';
import { AuthProvider } from '../lib/auth/AuthContext';
import { getLocale } from '../lib/i18n/getLocale';
import { LocaleProvider } from '../lib/i18n/LocaleContext';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Geist } from 'next/font/google';
import { headers } from 'next/headers';

import { cn } from '@/lib/utils';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

const WEB_BASE_URL = (
  process.env.NEXT_PUBLIC_WEB_BASE_URL ??
  process.env.NEXT_PUBLIC_BASE_URL ??
  'https://athlya.app'
).replace(/\/$/, '');
const DESCRIPTION = 'Plateforme fitness open-source, multi-tenant, RGPD-first.';

export const metadata: Metadata = {
  metadataBase: new URL(WEB_BASE_URL),
  title: {
    template: '%s — Athlya',
    default: 'Athlya — Réservez vos cours de fitness',
  },
  description: DESCRIPTION,
  openGraph: {
    title: 'Athlya',
    description: DESCRIPTION,
    type: 'website',
    locale: 'fr_FR',
    url: '/',
    siteName: 'Athlya',
    images: [{ url: '/images/athlya-og.png', width: 1200, height: 630, alt: 'Athlya' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Athlya',
    description: DESCRIPTION,
    images: ['/images/athlya-og.png'],
  },
  robots: { index: true, follow: true },
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const locale = await getLocale();
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning className={cn('font-sans', geist.variable)}>
      <body>
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'Athlya',
            description: DESCRIPTION,
            url: WEB_BASE_URL,
            logo: `${WEB_BASE_URL}/images/athlya-logo.png`,
            sameAs: [],
          }}
        />
        <ThemeProvider nonce={nonce}>
          <LocaleProvider locale={locale}>
            <AuthProvider>
              <AppNav />
              {children}
              <Toaster richColors position="top-right" />
              {/* Sprint-7 SP7.1 (Vague 35) — finalises
                              S5-009. The banner self-renders only on
                              first visit / after the 13-month CNIL
                              window elapsed (see
                              `lib/analytics-consent.ts` for the
                              `shouldPromptForConsent()` guard); it is
                              invisible for returning users with a
                              stored choice. As of Vague 35, the app
                              still loads zero third-party SDK — the
                              banner exists so the moment Plausible /
                              Sentry browser / PostHog land, the
                              consent gate is already wired and the
                              ePrivacy posture stays compliant. */}
              <CookieBanner />
            </AuthProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

// Expose the locale type so downstream tooling / tests can reuse the
// exact union the layout resolves.
export type { Locale } from '@athlya/shared/i18n';

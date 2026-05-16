'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

import { useAuth } from '../lib/auth/AuthContext';
import { useLocale } from '../lib/i18n/LocaleContext';
import { createTranslator } from '../lib/i18n/t';
import { LocaleSwitcher } from './LocaleSwitcher';

export function AppNav(): ReactElement {
    const pathname = usePathname();
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
        <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60">
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
            >
                {t('common.skipToContent')}
            </a>
            <nav
                className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3"
                aria-label="Navigation principale"
            >
                <Link href="/" className="text-sm font-semibold">
                    {t('common.appName')}
                </Link>

                <div className="flex items-center gap-4">
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
                                onClick={() => { void onLogout(); }}
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

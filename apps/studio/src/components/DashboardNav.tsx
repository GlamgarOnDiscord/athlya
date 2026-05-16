'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactElement } from 'react';

import { cn } from '@/lib/utils';

interface NavLink {
    readonly href: string;
    readonly label: string;
}

interface DashboardNavProps {
    readonly links: ReadonlyArray<NavLink>;
}

export function DashboardNav({ links }: DashboardNavProps): ReactElement {
    const pathname = usePathname();

    return (
        <nav className="flex flex-wrap gap-4 text-sm">
            {links.map(({ href, label }) => {
                const isActive = pathname === href || pathname.startsWith(`${href}/`);
                return (
                    <Link
                        key={href}
                        href={href}
                        className={cn(
                            isActive
                                ? 'font-semibold text-foreground underline underline-offset-4'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                        aria-current={isActive ? 'page' : undefined}
                    >
                        {label}
                    </Link>
                );
            })}
        </nav>
    );
}

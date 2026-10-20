'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { needsFullReload } from '../lib/full-reload';

import type { ReactElement, ReactNode } from 'react';

interface AppLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly title?: string;
  readonly 'aria-label'?: string;
  readonly children: ReactNode;
}

/**
 * `next/link` for every route, except a link that enters or leaves an
 * own-document route (`lib/full-reload.ts`), which gets a plain anchor.
 */
export function AppLink({ href, children, ...rest }: AppLinkProps): ReactElement {
  const pathname = usePathname();
  if (needsFullReload(href, pathname)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

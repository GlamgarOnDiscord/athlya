import Link from 'next/link';

import { needsFullReload } from '../lib/full-reload';

import type { ReactElement, ReactNode } from 'react';

interface AppLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * `next/link` for every route, except the ones that must load as a new
 * document (`lib/full-reload.ts`), which get a plain anchor.
 */
export function AppLink({ href, className, children }: AppLinkProps): ReactElement {
  if (needsFullReload(href)) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

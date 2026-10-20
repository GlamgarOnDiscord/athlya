/**
 * Shell of the member settings area (`/me/settings/*`). Each section is
 * its own route, listed in the sidebar "account" group; this layout only
 * provides the page column.
 */
import type { ReactElement, ReactNode } from 'react';

export default function SettingsLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      {children}
    </main>
  );
}

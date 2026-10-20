/**
 * Admin-protected layout for `/dashboard/*`.
 *
 * Wraps every dashboard segment in `<RequireAdmin>` so non-admins
 * never see the shell. The server-side gate (the API gateway's
 * `requireRole('admin')`) is the authoritative one — this client
 * gate is a UX shortcut.
 *
 * The layout renders the console shell (`DashboardNav`): a collapsible
 * sidebar on desktop and a drawer on mobile, with links to every
 * dashboard slice.
 *
 * @see Requirements 6.5, 14.1.
 */
import { DashboardNav } from '../../components/DashboardNav';
import { RequireAdmin } from '../../components/RequireAdmin';

import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <RequireAdmin>
      <DashboardNav>
        <main id="main-content" className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </DashboardNav>
    </RequireAdmin>
  );
}

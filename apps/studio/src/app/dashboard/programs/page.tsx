/**
 * `/dashboard/programs` — training program authoring (Epic 24, task 24.3).
 *
 * Server entry that delegates to the client `<ProgramsAdminList>`, which
 * renders the page header: the list and the editor each carry their own
 * title and actions. Inherits the `<RequireAdmin>` gate from
 * `app/dashboard/layout.tsx`; the API's `requireRole('admin')` and RLS
 * stay the authoritative checks.
 */
import { ProgramsAdminList } from './ProgramsAdminList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Programmes' };

export default function ProgramsAdminPage(): ReactElement {
  return <ProgramsAdminList />;
}

/**
 * `/dashboard/rooms`: the rooms of the studio (issue #748), in the
 * Configuration group. Admin only: it is not one of the `COACH_ROUTES` of
 * `<RequireAdmin>`, and the API's `requireRole('admin')` and RLS stay the
 * authoritative checks. The client `<RoomsAdmin>` holds the header, the
 * list and the dialogs.
 */
import { RoomsAdmin } from './RoomsAdmin';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Salles' };

export default function RoomsPage(): ReactElement {
  return <RoomsAdmin />;
}

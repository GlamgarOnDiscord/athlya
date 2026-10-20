/**
 * `/dashboard/members` — admin members directory.
 *
 * Server entry — delegates to the `<MembersAdminList>` client
 * component, which renders the page header (its export acts on the
 * loaded rows) and reads the cursor-paginated list from
 * `GET /v1/members` (admin / coach only, scoped to the active studio by
 * the API gateway's `requireRole` + tenant claims).
 *
 * The page is gated by `<RequireAdmin>` (inherited from the
 * dashboard layout) AND by the API itself — the gateway returns
 * 403 if a non-admin / non-coach user reaches the endpoint.
 *
 * @see Requirements 3.5, 6.5.
 */
import { MembersAdminList } from './MembersAdminList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Membres' };

export default function MembersAdminPage(): ReactElement {
  return <MembersAdminList />;
}

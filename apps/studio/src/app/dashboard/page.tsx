/**
 * `/dashboard` — admin landing.
 *
 * Renders the client `<DashboardOverview>`, which greets the signed-in
 * admin and reads the studio's classes, members and latest admin actions
 * with the authenticated API client.
 *
 * @see Task 12.1, docs/design/ui-direction.md ("Dashboard grid").
 */
import { DashboardOverview } from './DashboardOverview';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardHome(): ReactElement {
  return <DashboardOverview />;
}

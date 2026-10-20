/**
 * `/dashboard`: console landing.
 *
 * Renders the client `<DashboardLanding>`: an admin gets `<DashboardOverview>`
 * (the studio's classes, members and latest admin actions), a coach gets
 * `<CoachHome>` (their classes of the day and the week, and the kiosk).
 *
 * @see Task 12.1, docs/design/ui-direction.md ("Dashboard grid").
 */
import { DashboardLanding } from './coach/DashboardLanding';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardHome(): ReactElement {
  return <DashboardLanding />;
}

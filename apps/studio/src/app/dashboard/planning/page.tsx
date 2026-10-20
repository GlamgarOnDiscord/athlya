/**
 * `/dashboard/planning`: the coach's read-only schedule.
 *
 * Server entry that delegates to the client `<CoachPlanning>`, which reads
 * `GET /v1/classes` with the signed-in coach's token. The route is one of
 * the `COACH_ROUTES` of `<RequireAdmin>`; class edits stay on the admin
 * `/dashboard/classes` page and behind the API's admin role.
 */
import { CoachPlanning } from '../coach/CoachPlanning';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Planning' };

export default function CoachPlanningPage(): ReactElement {
  return <CoachPlanning />;
}

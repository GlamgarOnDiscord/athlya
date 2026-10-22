'use client';

/**
 * Landing of `/dashboard` by role: a coach and the front desk get the day
 * home (the coach's classes, or every class for the front desk), an admin
 * and a manager the studio overview. Nothing renders until the profile is
 * known, so a coach never fires the overview's admin-only requests.
 */
import { useAuth } from '../../../lib/auth/AuthContext';
import { readsPlanningOnly } from '../../../lib/auth/console-routes';
import { DashboardOverview } from '../DashboardOverview';

import { CoachHome } from './CoachHome';

import type { ReactElement } from 'react';

export function DashboardLanding(): ReactElement | null {
  const { user } = useAuth();
  if (user === null) return null;
  return readsPlanningOnly(user.role) ? <CoachHome /> : <DashboardOverview />;
}

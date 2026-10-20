'use client';

/**
 * Landing of `/dashboard` by role: a coach gets the coach home, an admin the
 * studio overview. Nothing renders until the profile is known, so a coach
 * never fires the overview's admin-only requests.
 */
import { useAuth } from '../../../lib/auth/AuthContext';
import { DashboardOverview } from '../DashboardOverview';

import { CoachHome } from './CoachHome';

import type { ReactElement } from 'react';

export function DashboardLanding(): ReactElement | null {
  const { user } = useAuth();
  if (user === null) return null;
  return user.role === 'coach' ? <CoachHome /> : <DashboardOverview />;
}

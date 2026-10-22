/**
 * `/dashboard/team`: the studio team and its roles (issue #756). Admins
 * and managers open it (`team.read`); only an admin changes the team.
 */
import { TeamPanel } from './TeamPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Équipe' };

export default function TeamPage(): ReactElement {
  return <TeamPanel />;
}

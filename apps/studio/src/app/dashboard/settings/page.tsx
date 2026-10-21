/**
 * `/dashboard/settings`: the studio settings (issue #759), admin only like
 * every page outside the coach routes of `<RequireAdmin>`.
 */
import { StudioSettingsForm } from './StudioSettingsForm';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Settings' };

export default function StudioSettingsPage(): ReactElement {
  return <StudioSettingsForm />;
}

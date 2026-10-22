/**
 * `/dashboard/integrations`: webhook endpoints of the studio (issue #760),
 * admin only.
 */
import { IntegrationsPanel } from './IntegrationsPanel';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Integrations' };

export default function IntegrationsPage(): ReactElement {
  return <IntegrationsPanel />;
}

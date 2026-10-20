import { AuditLogList } from './AuditLogList';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Audit log' };

export default function AuditPage(): ReactElement {
  return <AuditLogList />;
}

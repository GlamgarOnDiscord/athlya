import { CheckinKiosk } from './CheckinKiosk';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = { title: 'Check-in' };

export default function CheckinPage(): ReactElement {
  return <CheckinKiosk />;
}

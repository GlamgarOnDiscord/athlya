/**
 * `<CoachLink />` — link to `/me/coach`, rendered only when
 * `GET /v1/coach` reports the `ai-coach` flag on for the member.
 * Renders nothing while loading, when the flag is off and on error.
 */
'use client';

import Link from 'next/link';
import { type ReactElement } from 'react';

import { useCoachEnabled } from './use-coach-enabled';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';

export interface CoachLinkProps {
  readonly client: ApiClient;
  readonly t: Translator;
}

export function CoachLink({ client, t }: CoachLinkProps): ReactElement | null {
  const enabled = useCoachEnabled(client);

  if (!enabled) return null;
  return (
    <Link href="/me/coach" className="text-sm text-muted-foreground hover:text-foreground">
      {t('coach.link')}
    </Link>
  );
}

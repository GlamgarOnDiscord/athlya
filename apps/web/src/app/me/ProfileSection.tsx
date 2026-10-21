/**
 * Client umbrella for `/me`.
 *
 * Responsibilities:
 *  - Load the authenticated member's profile + consents through
 *    `<MemberProfileGate>` (loading, error with retry, ready).
 *  - On ready, forward the fetched `profile` and `consents` to the
 *    two form components as props so they own their own optimistic
 *    state and submission lifecycle.
 *
 * The umbrella builds the API client lazily: tests inject a stub
 * through the `client` prop, while production calls
 * `createApiClient({ baseUrl, getToken })` once.
 *
 * Translator handling: the component accepts an optional `t` prop
 * (used by tests + the RSC server boundary where functions cannot
 * cross). When the caller omits it, we derive one via `useLocale()`.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4.
 */
'use client';

import Link from 'next/link';
import { useMemo, type ReactElement } from 'react';

import { Separator } from '@/components/ui/separator';

import { type ApiClient } from '../../lib/api/client';
import { useApiClient } from '../../lib/api/use-api-client';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../lib/i18n/t';

import { CoachLink } from './coach/CoachLink';
import { ConsentsForm } from './ConsentsForm';
import { MemberProfileGate } from './MemberProfileGate';
import { ProfileForm } from './ProfileForm';

export interface ProfileSectionProps {
  /** Optional translator, derived from `useLocale()` when absent. */
  readonly t?: Translator;
  /** Test seam: inject a fake API client instead of the real one. */
  readonly client?: ApiClient;
}

export function ProfileSection({
  t: tProp,
  client: clientProp,
}: ProfileSectionProps): ReactElement {
  const locale = useLocale();
  const t: Translator = useMemo(() => tProp ?? createTranslator(locale), [tProp, locale]);

  const client = useApiClient(clientProp);

  return (
    <MemberProfileGate client={client} t={t}>
      {({ profile, consents }) => (
        <div className="flex flex-col gap-10">
          <ProfileForm profile={profile} client={client} t={t} />
          <ConsentsForm consents={consents} client={client} t={t} />
          <Separator />
          <nav className="flex flex-col gap-2" aria-label={t('profile.accountActions')}>
            <Link
              href="/me/progression"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t('workouts.progression.link')}
            </Link>
            <CoachLink client={client} t={t} />
            <Link
              href="/me/checkin"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t('checkin.link')}
            </Link>
            <Link
              href="/me/settings"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t('web.settings.title')}
            </Link>
            <Link href="/me/export" className="text-sm text-muted-foreground hover:text-foreground">
              {t('profile.dataExport')}
            </Link>
            <Link href="/me/delete" className="text-sm text-destructive hover:text-destructive/80">
              {t('profile.deleteAccount')}
            </Link>
          </nav>
        </div>
      )}
    </MemberProfileGate>
  );
}

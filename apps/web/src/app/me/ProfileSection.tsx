/**
 * Client umbrella for `/me`.
 *
 * Responsibilities:
 *  - Fetch the authenticated member's profile + consents once via
 *    `GET /v1/members/me`.
 *  - Render the three states (`loading`, `error` with retry, `ready`).
 *  - On `ready`, forward the fetched `profile` and `consents` to the
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
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

import { type ApiClient } from '../../lib/api/client';
import { useApiClient } from '../../lib/api/use-api-client';
import { useLocale } from '../../lib/i18n/LocaleContext';
import { createTranslator, type Translator } from '../../lib/i18n/t';

import { CalendarSection } from './calendar/CalendarSection';
import { CoachLink } from './coach/CoachLink';
import { ConsentsForm } from './ConsentsForm';
import { ProfileForm } from './ProfileForm';

import type { Consents } from '@athlya/shared/schemas';

/**
 * Shape of the profile fields we care about on this page. We decouple
 * from the full `User` schema because `/me` only needs a handful of
 * fields and pulling in `studioId`, `role`, etc. here would force
 * every consumer to worry about them.
 */
export interface MeProfile {
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/**
 * Raw `/v1/members/me` response the Hono gateway returns. Typed here
 * rather than pulled from `@athlya/shared/schemas/api` so we can
 * evolve the shape without cross-package churn — the API contract
 * mirrors `UserSchema` so every listed field is a subset.
 */
interface MeResponse {
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly consents: Consents;
}

type FetchStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly profile: MeProfile; readonly consents: Consents }
  | { readonly kind: 'error' };

export interface ProfileSectionProps {
  /** Optional translator — derived from `useLocale()` when absent. */
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

  const [status, setStatus] = useState<FetchStatus>({ kind: 'loading' });
  const [reloadNonce, setReloadNonce] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      queueMicrotask(() => {
        if (cancelled) return;
        setStatus({ kind: 'loading' });
      });
      let result: FetchStatus;
      try {
        const me = await client.get<MeResponse>('/v1/members/me');
        result = {
          kind: 'ready',
          profile: {
            email: me.email,
            displayName: me.displayName,
            avatarUrl: me.avatarUrl,
          },
          consents: me.consents,
        };
      } catch {
        result = { kind: 'error' };
      }
      if (!cancelled) setStatus(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

  const retry = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  if (status.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  if (status.kind === 'error') {
    return (
      <div className="flex flex-col gap-2" role="alert" aria-live="polite">
        <p className="text-sm text-destructive">{t('errors.generic')}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={retry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10" data-reload-key={reloadNonce}>
      <ProfileForm profile={status.profile} client={client} t={t} />
      <ConsentsForm consents={status.consents} client={client} t={t} />
      <CalendarSection client={client} t={t} />
      <Separator />
      <nav className="flex flex-col gap-2" aria-label={t('profile.accountActions')}>
        <Link
          href="/me/progression"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {t('workouts.progression.link')}
        </Link>
        <CoachLink client={client} t={t} />
        <Link href="/me/checkin" className="text-sm text-muted-foreground hover:text-foreground">
          {t('checkin.link')}
        </Link>
        <Link href="/me/export" className="text-sm text-muted-foreground hover:text-foreground">
          {t('profile.dataExport')}
        </Link>
        <Link href="/me/delete" className="text-sm text-destructive hover:text-destructive/80">
          {t('profile.deleteAccount')}
        </Link>
      </nav>
    </div>
  );
}

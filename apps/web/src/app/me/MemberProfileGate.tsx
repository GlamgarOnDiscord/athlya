/**
 * Loads the signed-in member's profile and consents once through
 * `GET /v1/members/me` and renders the loading, error (with retry) and
 * ready states. On ready it hands the data to `children`, so `/me` and
 * the settings sections share one fetch path instead of each repeating it.
 *
 * @see Requirements 3.1, 3.3.
 */
'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import type { ApiClient } from '../../lib/api/client';
import type { Translator } from '../../lib/i18n/t';
import type { Consents } from '@athlya/shared/schemas';

/**
 * Profile fields the member pages use. Decoupled from the full `User`
 * schema so the pages do not depend on `studioId`, `role`, etc.
 */
export interface MeProfile {
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

/** Subset of the `/v1/members/me` response read here. */
interface MeResponse {
  readonly email: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly consents: Consents;
}

export interface MemberProfileData {
  readonly profile: MeProfile;
  readonly consents: Consents;
}

type FetchStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: MemberProfileData }
  | { readonly kind: 'error' };

export interface MemberProfileGateProps {
  readonly client: ApiClient;
  readonly t: Translator;
  readonly children: (data: MemberProfileData) => ReactNode;
}

export function MemberProfileGate({ client, t, children }: MemberProfileGateProps): ReactElement {
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
          data: {
            profile: { email: me.email, displayName: me.displayName, avatarUrl: me.avatarUrl },
            consents: me.consents,
          },
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

  return <>{children(status.data)}</>;
}

/**
 * Custom web domain and e-mail sending domain: issue #761.
 *
 * Loads `GET /v1/studios/me/domains` and renders one card per kind.
 * Each card registers or replaces a hostname (`PUT`), lists the DNS
 * records to create with the result of the last lookup, runs a real
 * DNS check on demand (`POST .../check`) and removes the domain
 * (`DELETE`). A verified domain still waits for an operator to
 * activate it (Cloudflare or Resend), which the card says.
 */
'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { DomainCard } from './DomainCard';

import type {
  StudioDomain,
  StudioDomainKind,
  StudioDomainsResponse,
} from '@athlya/shared/schemas/api';

const KINDS: readonly StudioDomainKind[] = ['web', 'email'];

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly StudioDomain[] }
  | { readonly kind: 'error' };

export function DomainsPanel(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);
  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.get<StudioDomainsResponse>('/v1/studios/me/domains');
        if (!cancelled) setStatus({ kind: 'ready', items: res.items });
      } catch {
        if (!cancelled) setStatus({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reload]);

  const onChange = useCallback((kind: StudioDomainKind, domain: StudioDomain | null) => {
    setStatus((s) =>
      s.kind !== 'ready'
        ? s
        : {
            kind: 'ready',
            items: [...s.items.filter((d) => d.kind !== kind), ...(domain ? [domain] : [])],
          },
    );
  }, []);

  if (status.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border p-4">
        <p className="text-sm">{t('studio.branding.domains.loadError')}</p>
        <Button
          variant="outline"
          onClick={() => {
            setStatus({ kind: 'loading' });
            setReload((n) => n + 1);
          }}
        >
          {t('studio.branding.retry')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {KINDS.map((kind) => (
        <DomainCard
          key={kind}
          kind={kind}
          domain={status.items.find((d) => d.kind === kind) ?? null}
          client={client}
          t={t}
          locale={locale}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

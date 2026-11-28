/**
 * Live branding panel: slice B9.1 + B9.2, white label (issue #761).
 *
 * Client-side wrapper that fetches `GET /v1/studios/me` once on
 * mount and renders the three editors of the studio identity: logos
 * (light and dark), brand color with its live contrast reading, and the
 * Athlya mention of the e-mails. Each editor saves on its own and hands
 * the updated studio back, so the panel always shows the stored row.
 *
 * Why a client component instead of a Server Component?
 * -----------------------------------------------------
 * The studio access token lives in an in-memory store
 * (`token-store.ts`) bound to the auth context — Server Components
 * cannot reach it. Wrapping the read in a `useEffect` keyed on the
 * token is the simplest path.
 *
 * @see Requirement 13.2 (per-tenant branding read).
 */
'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { AthlyaMention } from './AthlyaMention';
import { BrandingPreview } from './BrandingPreview';
import { LogoEditor } from './LogoEditor';

import type { StudioMeResponse } from '@athlya/shared/schemas/api';

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly studio: StudioMeResponse }
  | { readonly kind: 'error' };

export function BrandingPanel(): ReactElement {
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
        const studio = await client.get<StudioMeResponse>('/v1/studios/me');
        if (!cancelled) setStatus({ kind: 'ready', studio });
      } catch {
        if (!cancelled) setStatus({ kind: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reload]);

  const onSaved = useCallback((studio: StudioMeResponse) => {
    setStatus({ kind: 'ready', studio });
  }, []);

  if (status.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border p-4">
        <p className="text-sm">{t('studio.branding.loadError')}</p>
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

  const { studio } = status;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('studio.branding.logo.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('studio.branding.logo.help')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <LogoEditor
              variant="light"
              value={studio.brandLogoLight}
              studioName={studio.name}
              client={client}
              t={t}
              onSaved={onSaved}
            />
            <LogoEditor
              variant="dark"
              value={studio.brandLogoDark}
              studioName={studio.name}
              client={client}
              t={t}
              onSaved={onSaved}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('studio.branding.brandColor.label')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t('studio.branding.brandColor.help')}</p>
          <BrandingPreview color={studio.brandColor} client={client} t={t} onSaved={onSaved} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('studio.branding.mention.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AthlyaMention
            hidden={studio.hideAthlyaBranding}
            client={client}
            t={t}
            onSaved={onSaved}
          />
        </CardContent>
      </Card>
    </div>
  );
}

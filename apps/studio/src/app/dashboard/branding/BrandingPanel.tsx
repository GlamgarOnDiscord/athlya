/**
 * Live branding panel — slice B9.1 + B9.2.
 *
 * Client-side wrapper that fetches `GET /v1/studios/me` once on
 * mount and feeds the result into {@link BrandingPreview}. Until the
 * fetch resolves we show a tight Skeleton so the layout doesn't
 * jump.
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

import { Skeleton } from '@/components/ui/skeleton';

import { useApiClient } from '../../../lib/api/buildClient';
import { useAuth } from '../../../lib/auth/AuthContext';
import { useLocale } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { BrandingPreview } from './BrandingPreview';

interface StudioMe {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly brandColor: string;
  readonly brandLogo?: string | null;
}

const FALLBACK_COLOR = '#0EA5E9';

type Status =
  { kind: 'loading' } | { kind: 'ready'; color: string } | { kind: 'error'; message: string };

export function BrandingPanel(): ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale), [locale]);

  const { accessToken } = useAuth();
  const getToken = useCallback(() => accessToken, [accessToken]);
  const client = useApiClient(getToken);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        const studio = await client.get<StudioMe>('/v1/studios/me');
        if (cancelled) return;
        setStatus({ kind: 'ready', color: studio.brandColor });
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', message });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (status.kind === 'loading') {
    return (
      <div className="flex flex-wrap items-center gap-4">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
    );
  }
  if (status.kind === 'error') {
    // Render the editor anyway against the fallback color so the
    // admin can still issue a PATCH — losing the read shouldn't
    // wedge the write surface.
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {t('studio.branding.saveError')}: {status.message}
        </p>
        <BrandingPreview color={FALLBACK_COLOR} />
      </div>
    );
  }
  return <BrandingPreview color={status.color} />;
}

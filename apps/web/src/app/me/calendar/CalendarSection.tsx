/**
 * `/me` "Sync my calendar" block (issue #719): the member's subscription
 * URL from `GET /v1/calendar/feed-url`, shown as `webcal://` with a copy
 * button, an "open in my calendar app" link and short instructions for
 * Google, Apple and Outlook. A 503 (feed not configured) or any failure
 * hides the URL behind a neutral message. One-off "Add to calendar" lives
 * on the upcoming bookings list of the same page.
 *
 * The URL is a personal credential: it is fetched on demand, never
 * cached by the API (`no-store`), and the block says so.
 */
'use client';

import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';

interface FeedUrlResponse {
  readonly httpsUrl: string;
  readonly webcalUrl: string;
}

type FeedState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly webcalUrl: string }
  | { readonly kind: 'unavailable' };

type CopyState = 'idle' | 'copied' | 'failed';

export interface CalendarSectionProps {
  readonly client: ApiClient;
  readonly t: Translator;
}

export function CalendarSection({ client, t }: CalendarSectionProps): ReactElement {
  const headingId = useId();
  const howToHeadingId = useId();
  const urlInputId = useId();

  const [feed, setFeed] = useState<FeedState>({ kind: 'loading' });
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: FeedState;
      try {
        const body = await client.get<FeedUrlResponse>('/v1/calendar/feed-url');
        next = { kind: 'ready', webcalUrl: body.webcalUrl };
      } catch {
        next = { kind: 'unavailable' };
      }
      if (!cancelled) setFeed(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const onCopy = useCallback(async () => {
    if (feed.kind !== 'ready') return;
    try {
      await navigator.clipboard.writeText(feed.webcalUrl);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }, [feed]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-xl font-semibold">
        {t('calendar.sync.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('calendar.sync.description')}</p>

      {feed.kind === 'loading' ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : feed.kind === 'unavailable' ? (
        <p className="text-sm text-muted-foreground">{t('calendar.sync.unavailable')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={urlInputId}>{t('calendar.sync.urlLabel')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={urlInputId}
                value={feed.webcalUrl}
                readOnly
                spellCheck={false}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={() => void onCopy()}>
                {t('calendar.sync.copy')}
              </Button>
            </div>
            <p role="status" aria-live="polite" className="min-h-5 text-sm">
              {copy === 'copied'
                ? t('calendar.sync.copied')
                : copy === 'failed'
                  ? t('calendar.sync.copyError')
                  : ''}
            </p>
          </div>
          <a
            href={feed.webcalUrl}
            className={buttonVariants({
              variant: 'default',
              size: 'default',
              className: 'self-start',
            })}
          >
            {t('calendar.sync.open')}
          </a>
          <div className="flex flex-col gap-1">
            <h3 id={howToHeadingId} className="text-base font-semibold">
              {t('calendar.sync.howTo')}
            </h3>
            <ul aria-labelledby={howToHeadingId} className="list-disc pl-5 text-sm">
              <li>{t('calendar.sync.google')}</li>
              <li>{t('calendar.sync.apple')}</li>
              <li>{t('calendar.sync.outlook')}</li>
            </ul>
          </div>
          <p className="text-sm text-muted-foreground">{t('calendar.sync.refresh')}</p>
          <p className="text-sm text-muted-foreground">{t('calendar.sync.privacy')}</p>
        </div>
      )}
    </section>
  );
}

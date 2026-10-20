/**
 * `/me` calendar block (issue #719).
 *
 *   - "Sync my calendar": the member's subscription URL from
 *     `GET /v1/calendar/feed-url`, shown as `webcal://` with a copy button,
 *     an "open in my calendar app" link and short instructions for Google,
 *     Apple and Outlook. A 503 (feed not configured) or any failure hides
 *     the URL behind a neutral message.
 *   - "My upcoming classes": confirmed bookings of the next 30 days from
 *     `GET /v1/reservations/me`, each with "Add to calendar".
 *
 * The URL is a personal credential: it is fetched on demand, never
 * cached by the API (`no-store`), and the block says so.
 */
'use client';

import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

import { AddToCalendar } from '@/components/calendar/AddToCalendar';
import { buttonVariants } from '@/components/ui/button-variants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useLocale } from '../../../lib/i18n/LocaleContext';

import type { ApiClient } from '../../../lib/api/client';
import type { Translator } from '../../../lib/i18n/t';

/** Upcoming bookings window, in days. */
const UPCOMING_DAYS = 30;
/** Bookings listed at most. */
const UPCOMING_LIMIT = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface FeedUrlResponse {
  readonly httpsUrl: string;
  readonly webcalUrl: string;
}

/** Subset of a `GET /v1/reservations/me` item this block reads. */
interface ReservationItem {
  readonly id: string;
  readonly classId: string;
  readonly status: string;
  readonly class: {
    readonly title: string;
    readonly startsAt: string;
    readonly durationMin: number;
  };
}

type FeedState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly webcalUrl: string }
  | { readonly kind: 'unavailable' };

type UpcomingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly ReservationItem[] }
  | { readonly kind: 'error' };

type CopyState = 'idle' | 'copied' | 'failed';

export interface CalendarSectionProps {
  readonly client: ApiClient;
  readonly t: Translator;
}

export function CalendarSection({ client, t }: CalendarSectionProps): ReactElement {
  const locale = useLocale();
  const headingId = useId();
  const upcomingHeadingId = useId();
  const howToHeadingId = useId();
  const urlInputId = useId();

  const [feed, setFeed] = useState<FeedState>({ kind: 'loading' });
  const [upcoming, setUpcoming] = useState<UpcomingState>({ kind: 'loading' });
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
    void (async () => {
      const now = Date.now();
      const qs = new URLSearchParams({
        from: new Date(now).toISOString(),
        to: new Date(now + UPCOMING_DAYS * MS_PER_DAY).toISOString(),
        limit: '50',
      }).toString();
      let next: UpcomingState;
      try {
        const body = await client.get<{ readonly items: readonly ReservationItem[] }>(
          `/v1/reservations/me?${qs}`,
        );
        next = {
          kind: 'ready',
          items: body.items.filter((item) => item.status === 'confirmed').slice(0, UPCOMING_LIMIT),
        };
      } catch {
        next = { kind: 'error' };
      }
      if (!cancelled) setUpcoming(next);
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

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );

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

      <div className="flex flex-col gap-3">
        <h3 id={upcomingHeadingId} className="text-base font-semibold">
          {t('calendar.upcoming.title')}
        </h3>
        {upcoming.kind === 'loading' ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : upcoming.kind === 'error' ? (
          <p className="text-sm text-destructive">{t('errors.generic')}</p>
        ) : upcoming.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('calendar.upcoming.empty')}</p>
        ) : (
          <ul aria-labelledby={upcomingHeadingId} className="flex list-none flex-col gap-4 p-0">
            {upcoming.items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-col">
                  <span className="font-medium">{item.class.title}</span>
                  <time dateTime={item.class.startsAt} className="text-sm text-muted-foreground">
                    {fmt.format(new Date(item.class.startsAt))}
                  </time>
                </div>
                <AddToCalendar
                  event={{
                    classId: item.classId,
                    reservationId: item.id,
                    title: item.class.title,
                    startsAt: item.class.startsAt,
                    durationMin: item.class.durationMin,
                  }}
                  t={t}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

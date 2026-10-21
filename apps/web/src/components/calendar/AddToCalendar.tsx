/**
 * "Add to calendar" for one booked class (issue #719).
 *
 * Two plain links, no API call:
 *   - an iCalendar file built in the browser with the shared serializer
 *     (`@athlya/shared/calendar`) and offered as a `data:` download, so
 *     Apple Calendar, Outlook and any RFC 5545 client can import it;
 *   - a Google Calendar template link that opens a pre-filled event in a
 *     new tab. Nothing is saved until the member confirms there.
 *
 * Each link appends the class title in visually hidden text, so a page
 * listing several classes keeps distinct link names (WCAG 2.4.4) whose
 * start matches the visible label (WCAG 2.5.3).
 */

import {
  ATHLYA_ICS_PRODUCT_ID,
  buildGoogleCalendarUrl,
  reservationEventUid,
  serializeIcs,
} from '@athlya/shared/calendar';
import { useId, useMemo, type ReactElement } from 'react';

import { buttonVariants } from '@/components/ui/button-variants';

import type { Translator } from '../../lib/i18n/t';

/** The booked class as the calendar event needs it. */
export interface CalendarEventInfo {
  /** Class id, used for the file name and the fallback event UID. */
  readonly classId: string;
  /** Booking id when known: the event then shares its UID with the feed. */
  readonly reservationId?: string | undefined;
  readonly title: string;
  /** ISO-8601 start. */
  readonly startsAt: string;
  readonly durationMin: number;
}

export interface AddToCalendarProps {
  readonly event: CalendarEventInfo;
  readonly t: Translator;
}

const MS_PER_MINUTE = 60_000;

export function AddToCalendar({ event, t }: AddToCalendarProps): ReactElement | null {
  const labelId = useId();
  const links = useMemo(() => {
    const start = new Date(event.startsAt);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start.getTime() + event.durationMin * MS_PER_MINUTE);
    const ics = serializeIcs({
      prodId: ATHLYA_ICS_PRODUCT_ID,
      events: [
        {
          uid:
            event.reservationId !== undefined
              ? reservationEventUid(event.reservationId)
              : `class-${event.classId}@athlya.app`,
          start,
          end,
          stamp: new Date(),
          summary: event.title,
          status: 'CONFIRMED',
        },
      ],
    });
    return {
      icsHref: `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`,
      fileName: `athlya-${start.toISOString().slice(0, 10)}-${event.classId}.ics`,
      googleHref: buildGoogleCalendarUrl({ title: event.title, start, end }),
    };
  }, [event]);

  if (links === null) return null;

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {t('calendar.add.label')}
      </span>
      <div className="flex flex-wrap gap-2">
        <a
          href={links.icsHref}
          download={links.fileName}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('calendar.add.download')}{' '}
          <span className="sr-only">{t('calendar.add.forClass', { title: event.title })}</span>
        </a>
        <a
          href={links.googleHref}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('calendar.add.google')}{' '}
          <span className="sr-only">
            {t('calendar.add.forClass', { title: event.title })} {t('calendar.add.newTab')}
          </span>
        </a>
      </div>
    </div>
  );
}

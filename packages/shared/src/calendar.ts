/**
 * iCalendar (RFC 5545) serialisation and calendar deep links.
 *
 * Shared by the API (the member's subscription feed, issue #719) and
 * the web app (the single-event `.ics` download on a booked class), so
 * both emit byte-identical events for the same booking. Pure and
 * dependency-free: no `Date` arithmetic beyond UTC formatting and no
 * platform API, so it runs on Workers, Node and the browser alike.
 *
 * Every timestamp is written in UTC (`DTSTART:20261021T180000Z`), so a
 * feed never needs a `VTIMEZONE` block and each calendar client renders
 * the event in its own zone.
 */

/** `STATUS` values used for a `VEVENT` (RFC 5545 §3.8.1.11). */
export type IcsEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

/** One `VEVENT`. */
export interface IcsEvent {
  /** Globally unique and stable across refreshes of the same booking. */
  readonly uid: string;
  readonly start: Date;
  readonly end: Date;
  /** Last revision of the event; also the stamp of a one-off download. */
  readonly stamp: Date;
  readonly summary: string;
  readonly location?: string | undefined;
  readonly description?: string | undefined;
  readonly url?: string | undefined;
  readonly status?: IcsEventStatus | undefined;
  /** Revision counter (RFC 5545 §3.8.7.4); clients replace on a higher value. */
  readonly sequence?: number | undefined;
}

/** A `VCALENDAR` with its events. */
export interface IcsCalendar {
  /** `PRODID`, e.g. `-//Athlya//Calendar feed//EN`. */
  readonly prodId: string;
  /** Display name (`X-WR-CALNAME` and `NAME`) for subscription feeds. */
  readonly name?: string | undefined;
  /** Suggested polling interval for subscription feeds, in minutes. */
  readonly refreshIntervalMinutes?: number | undefined;
  readonly events: readonly IcsEvent[];
}

/** `PRODID` of every calendar Athlya writes. */
export const ATHLYA_ICS_PRODUCT_ID = '-//Athlya//Calendar//EN';

/**
 * `UID` of a booking's event. The feed and the one-off download use the
 * same value, so a client that sees both treats them as one event.
 */
export function reservationEventUid(reservationId: string): string {
  return `reservation-${reservationId}@athlya.app`;
}

/** RFC 5545 §3.1: content lines are delimited by CRLF. */
export const ICS_LINE_BREAK = '\r\n';

/** RFC 5545 §3.1: lines SHOULD NOT be longer than 75 octets, excluding the line break. */
export const ICS_MAX_LINE_OCTETS = 75;

/** MIME type of an iCalendar object (RFC 5545 §8.1). */
export const ICS_CONTENT_TYPE = 'text/calendar; charset=utf-8';

// Control characters TEXT may not carry (RFC 5545 §3.3.11: TSAFE-CHAR
// allows HTAB but no other CONTROL). Line breaks are handled first.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

/**
 * Escape a TEXT property value (RFC 5545 §3.3.11): backslash, semicolon
 * and comma are backslash-escaped, any line break becomes the literal
 * `\n`, and the other control characters are dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/gu, '\n')
    .replace(FORBIDDEN_CONTROLS, '')
    .replace(/\\/gu, '\\\\')
    .replace(/;/gu, '\\;')
    .replace(/,/gu, '\\,')
    .replace(/\n/gu, '\\n');
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Format `date` as a UTC DATE-TIME (`YYYYMMDDTHHMMSSZ`, RFC 5545
 * §3.3.5 form #2). Milliseconds are truncated. Throws on an invalid date
 * so a malformed row never yields a silently broken event.
 */
export function formatIcsUtc(date: Date): string {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('formatIcsUtc: invalid date');
  }
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Fold one content line (RFC 5545 §3.1): no physical line exceeds 75
 * octets of UTF-8, continuation lines start with a single space (which
 * counts towards their 75 octets), and a multi-octet character is never
 * split across two lines.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (octets + size > ICS_MAX_LINE_OCTETS) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(ICS_LINE_BREAK);
}

function eventLines(event: IcsEvent): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${formatIcsUtc(event.stamp)}`,
    `DTSTART:${formatIcsUtc(event.start)}`,
    `DTEND:${formatIcsUtc(event.end)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
  ];
  if (event.location !== undefined && event.location !== '') {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (event.description !== undefined && event.description !== '') {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.url !== undefined && event.url !== '') {
    // URI value type: not TEXT-escaped, but a line break would end the line.
    lines.push(`URL:${event.url.replace(FORBIDDEN_CONTROLS, '').replace(/[\r\n]/gu, '')}`);
  }
  if (event.status !== undefined) {
    lines.push(`STATUS:${event.status}`);
  }
  if (event.sequence !== undefined) {
    lines.push(`SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`);
  }
  lines.push('TRANSP:OPAQUE', 'END:VEVENT');
  return lines;
}

/**
 * Serialise `calendar` into an iCalendar object: folded lines, CRLF
 * delimiters and a trailing CRLF. Events are written in the given order.
 */
export function serializeIcs(calendar: IcsCalendar): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${escapeIcsText(calendar.prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (calendar.name !== undefined && calendar.name !== '') {
    const name = escapeIcsText(calendar.name);
    lines.push(`NAME:${name}`, `X-WR-CALNAME:${name}`);
  }
  if (calendar.refreshIntervalMinutes !== undefined) {
    const minutes = Math.max(1, Math.trunc(calendar.refreshIntervalMinutes));
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${minutes}M`, `X-PUBLISHED-TTL:PT${minutes}M`);
  }
  for (const event of calendar.events) {
    lines.push(...eventLines(event));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join(ICS_LINE_BREAK) + ICS_LINE_BREAK;
}

/** Fields of a Google Calendar "create event" deep link. */
export interface GoogleCalendarEvent {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly location?: string | undefined;
  readonly details?: string | undefined;
}

/**
 * Google Calendar template link that opens a pre-filled "new event"
 * form. Nothing is written to the member's calendar until they save it.
 */
export function buildGoogleCalendarUrl(event: GoogleCalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${formatIcsUtc(event.start)}/${formatIcsUtc(event.end)}`,
  });
  if (event.location !== undefined && event.location !== '') {
    params.set('location', event.location);
  }
  if (event.details !== undefined && event.details !== '') {
    params.set('details', event.details);
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

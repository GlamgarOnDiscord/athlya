/**
 * iCalendar serialiser and Google Calendar link (issue #719).
 */

import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';

import {
  ICS_LINE_BREAK,
  buildGoogleCalendarUrl,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  serializeIcs,
  type IcsEvent,
} from '../src/calendar.js';

const encoder = new TextEncoder();

/** Undo RFC 5545 folding: a CRLF followed by one space is removed. */
function unfold(text: string): string {
  return text.replace(/\r\n /gu, '');
}

const EVENT: IcsEvent = {
  uid: 'reservation-0b9c@athlya.app',
  start: new Date('2026-10-21T18:00:00.000Z'),
  end: new Date('2026-10-21T18:45:00.000Z'),
  stamp: new Date('2026-10-01T09:30:12.345Z'),
  summary: 'Yoga flow',
  location: 'Studio Camille Durand',
  status: 'CONFIRMED',
  sequence: 2,
};

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon and comma', () => {
    expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
  });

  it('turns every line break into a literal \\n', () => {
    expect(escapeIcsText('one\r\ntwo\nthree\rfour')).toBe('one\\ntwo\\nthree\\nfour');
  });

  it('drops control characters but keeps tabs and non-ASCII text', () => {
    expect(escapeIcsText('a\u0000b\u0007c\u007Fd\te é')).toBe('abcd\te é');
  });

  it('leaves colons and double quotes untouched', () => {
    expect(escapeIcsText('Cours : "HIIT"')).toBe('Cours : "HIIT"');
  });
});

describe('formatIcsUtc', () => {
  it('formats a UTC DATE-TIME and truncates milliseconds', () => {
    expect(formatIcsUtc(new Date('2026-03-05T07:08:09.999Z'))).toBe('20260305T070809Z');
  });

  it('converts an offset timestamp to UTC', () => {
    // 20:30 in Paris (UTC+2 in summer time) is 18:30 UTC.
    expect(formatIcsUtc(new Date('2026-07-14T20:30:00+02:00'))).toBe('20260714T183000Z');
  });

  it('rolls the date over when the offset crosses midnight', () => {
    expect(formatIcsUtc(new Date('2026-12-31T23:30:00-05:00'))).toBe('20270101T043000Z');
  });

  it('rejects an invalid date', () => {
    expect(() => formatIcsUtc(new Date('not a date'))).toThrow(RangeError);
  });
});

describe('foldIcsLine', () => {
  it('leaves a 75-octet line alone', () => {
    const line = 'X'.repeat(75);
    expect(foldIcsLine(line)).toBe(line);
  });

  it('folds a long ASCII line into 75-octet physical lines', () => {
    const line = `SUMMARY:${'a'.repeat(200)}`;
    const folded = foldIcsLine(line);
    const physical = folded.split(ICS_LINE_BREAK);
    expect(physical.length).toBeGreaterThan(1);
    for (const [index, part] of physical.entries()) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(' ')).toBe(true);
    }
    expect(physical[0]).toHaveLength(75);
    expect(unfold(folded)).toBe(line);
  });

  it('never splits a multi-octet character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}${'🏋'.repeat(20)}`;
    const folded = foldIcsLine(line);
    for (const part of folded.split(ICS_LINE_BREAK)) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      expect(part).not.toContain('�');
    }
    expect(unfold(folded)).toBe(line);
  });

  test.prop([fc.string({ unit: 'binary', maxLength: 400 })])(
    'round-trips and respects the octet limit for any text',
    (text) => {
      const line = `DESCRIPTION:${escapeIcsText(text)}`;
      const folded = foldIcsLine(line);
      for (const part of folded.split(ICS_LINE_BREAK)) {
        expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      }
      expect(unfold(folded)).toBe(line);
    },
  );
});

describe('serializeIcs', () => {
  it('writes a CRLF-delimited calendar with a trailing CRLF', () => {
    const ics = serializeIcs({ prodId: '-//Athlya//Calendar feed//EN', events: [EVENT] });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/gu, '')).not.toMatch(/[\r\n]/u);
    expect(ics.split(ICS_LINE_BREAK)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Athlya//Calendar feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:reservation-0b9c@athlya.app',
      'DTSTAMP:20261001T093012Z',
      'DTSTART:20261021T180000Z',
      'DTEND:20261021T184500Z',
      'SUMMARY:Yoga flow',
      'LOCATION:Studio Camille Durand',
      'STATUS:CONFIRMED',
      'SEQUENCE:2',
      'TRANSP:OPAQUE',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('adds the feed name and refresh hints when given', () => {
    const ics = serializeIcs({
      prodId: '-//Athlya//Calendar feed//EN',
      name: 'Studio, Lyon',
      refreshIntervalMinutes: 60,
      events: [],
    });
    expect(ics).toContain('NAME:Studio\\, Lyon\r\n');
    expect(ics).toContain('X-WR-CALNAME:Studio\\, Lyon\r\n');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT60M\r\n');
    expect(ics).toContain('X-PUBLISHED-TTL:PT60M\r\n');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('escapes user-controlled text so it cannot inject properties', () => {
    const ics = serializeIcs({
      prodId: '-//Athlya//Calendar feed//EN',
      events: [{ ...EVENT, summary: 'Yoga\r\nEND:VEVENT\r\nBEGIN:VEVENT; evil, yes' }],
    });
    const lines = unfold(ics).split(ICS_LINE_BREAK);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines).toContain('SUMMARY:Yoga\\nEND:VEVENT\\nBEGIN:VEVENT\\; evil\\, yes');
  });

  it('marks a cancelled event and omits empty optional properties', () => {
    const ics = serializeIcs({
      prodId: '-//Athlya//Calendar feed//EN',
      events: [{ ...EVENT, status: 'CANCELLED', location: '', sequence: 3 }],
    });
    expect(ics).toContain('STATUS:CANCELLED\r\n');
    expect(ics).toContain('SEQUENCE:3\r\n');
    expect(ics).not.toContain('LOCATION:');
  });

  it('folds long lines inside the calendar', () => {
    const ics = serializeIcs({
      prodId: '-//Athlya//Calendar feed//EN',
      events: [{ ...EVENT, description: 'Échauffement, gainage; '.repeat(10) }],
    });
    for (const line of ics.split(ICS_LINE_BREAK)) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('buildGoogleCalendarUrl', () => {
  it('builds a TEMPLATE link with UTC dates', () => {
    const url = new URL(
      buildGoogleCalendarUrl({
        title: 'Yoga & mobilité',
        start: EVENT.start,
        end: EVENT.end,
        location: 'Studio Camille Durand',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Yoga & mobilité');
    expect(url.searchParams.get('dates')).toBe('20261021T180000Z/20261021T184500Z');
    expect(url.searchParams.get('location')).toBe('Studio Camille Durand');
    expect(url.searchParams.has('details')).toBe(false);
  });
});

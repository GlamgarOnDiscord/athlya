/**
 * Component tests for `<AddToCalendar />` (issue #719).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createTranslator } from '../../lib/i18n/t';

import { AddToCalendar, type CalendarEventInfo } from './AddToCalendar';

const t = createTranslator('fr');

const EVENT: CalendarEventInfo = {
  classId: 'class-1',
  reservationId: 'reservation-1',
  title: 'Yoga, flow',
  startsAt: '2026-10-21T18:00:00.000Z',
  durationMin: 45,
};

afterEach(() => {
  cleanup();
});

function icsOf(link: HTMLElement): string {
  const href = link.getAttribute('href') ?? '';
  const prefix = 'data:text/calendar;charset=utf-8,';
  expect(href.startsWith(prefix)).toBe(true);
  return decodeURIComponent(href.slice(prefix.length));
}

describe('<AddToCalendar />', () => {
  it('offers a one-event iCalendar download that shares the feed UID', () => {
    render(<AddToCalendar event={EVENT} t={t} />);

    const link = screen.getByRole('link', { name: 'Fichier .ics pour « Yoga, flow »' });
    expect(link.getAttribute('download')).toBe('athlya-2026-10-21-class-1.ics');
    const ics = icsOf(link);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:reservation-reservation-1@athlya.app\r\n');
    expect(ics).toContain('DTSTART:20261021T180000Z\r\nDTEND:20261021T184500Z\r\n');
    expect(ics).toContain('SUMMARY:Yoga\\, flow\r\n');
    expect(ics.match(/BEGIN:VEVENT/gu)).toHaveLength(1);
  });

  it('falls back to a class UID when the booking id is unknown', () => {
    render(<AddToCalendar event={{ ...EVENT, reservationId: undefined }} t={t} />);

    const link = screen.getByRole('link', { name: /^Fichier \.ics/u });
    expect(icsOf(link)).toContain('UID:class-class-1@athlya.app\r\n');
  });

  it('links to a pre-filled Google Calendar event in a new tab', () => {
    render(<AddToCalendar event={EVENT} t={t} />);

    const link = screen.getByRole('link', {
      name: 'Google Agenda pour « Yoga, flow » (nouvel onglet)',
    });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const url = new URL(link.getAttribute('href') ?? '');
    expect(url.hostname).toBe('calendar.google.com');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Yoga, flow');
    expect(url.searchParams.get('dates')).toBe('20261021T180000Z/20261021T184500Z');
  });

  it('renders nothing for an invalid start date', () => {
    const { container } = render(
      <AddToCalendar event={{ ...EVENT, startsAt: 'not-a-date' }} t={t} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

/**
 * Component tests for `<CalendarSection />` (issue #719).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/i18n/LocaleContext', () => ({
  useLocale: () => 'fr',
}));

import { ApiServerError, type ApiClient } from '../../../lib/api/client';
import { createTranslator } from '../../../lib/i18n/t';

import { CalendarSection } from './CalendarSection';

const t = createTranslator('fr');

const WEBCAL = 'webcal://api.athlya.test/v1/calendar/feed.ics?token=abc.def';

const RESERVATIONS = {
  items: [
    {
      id: 'reservation-1',
      classId: 'class-1',
      status: 'confirmed',
      class: { title: 'Yoga', startsAt: '2030-01-07T08:00:00.000Z', durationMin: 60 },
    },
    {
      id: 'reservation-2',
      classId: 'class-2',
      status: 'waitlist',
      class: { title: 'HIIT', startsAt: '2030-01-08T08:00:00.000Z', durationMin: 30 },
    },
  ],
  nextCursor: null,
};

function clientWith(get: ApiClient['get']): ApiClient {
  return { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() } as unknown as ApiClient;
}

function routes(feed: () => Promise<unknown>, reservations: () => Promise<unknown>) {
  return vi.fn(async (path: string) => {
    if (path === '/v1/calendar/feed-url') return feed();
    if (path.startsWith('/v1/reservations/me?')) return reservations();
    throw new Error(`unexpected ${path}`);
  }) as unknown as ApiClient['get'];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<CalendarSection />', () => {
  it('shows the webcal URL, copies it and lists confirmed bookings only', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const get = routes(
      async () => ({ httpsUrl: WEBCAL.replace('webcal:', 'https:'), webcalUrl: WEBCAL }),
      async () => RESERVATIONS,
    );
    render(<CalendarSection client={clientWith(get)} t={t} />);

    const input = await screen.findByLabelText(t('calendar.sync.urlLabel'));
    expect((input as HTMLInputElement).value).toBe(WEBCAL);
    expect((input as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole('link', { name: t('calendar.sync.open') }).getAttribute('href')).toBe(
      WEBCAL,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('calendar.sync.copy') }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(WEBCAL);
    expect(screen.getByRole('status').textContent).toBe(t('calendar.sync.copied'));

    expect(await screen.findByText('Yoga')).toBeDefined();
    expect(screen.queryByText('HIIT')).toBeNull();
    expect(screen.getAllByRole('group', { name: t('calendar.add.label') })).toHaveLength(1);
  });

  it('asks for the next 30 days of bookings', async () => {
    const get = routes(
      async () => ({ httpsUrl: '', webcalUrl: WEBCAL }),
      async () => ({ items: [], nextCursor: null }),
    );
    render(<CalendarSection client={clientWith(get)} t={t} />);

    expect(await screen.findByText(t('calendar.upcoming.empty'))).toBeDefined();
    const call = vi.mocked(get).mock.calls.find(([path]) => path.startsWith('/v1/reservations'));
    const query = new URLSearchParams((call?.[0] ?? '').split('?')[1]);
    const days =
      (Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? '')) / 86_400_000;
    expect(days).toBe(30);
  });

  it('reports a copy failure so the member can copy by hand', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    const get = routes(
      async () => ({ httpsUrl: '', webcalUrl: WEBCAL }),
      async () => RESERVATIONS,
    );
    render(<CalendarSection client={clientWith(get)} t={t} />);

    const copy = await screen.findByRole('button', { name: t('calendar.sync.copy') });
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toBe(t('calendar.sync.copyError'));
  });

  it('hides the URL when the feed is not configured', async () => {
    const get = routes(
      async () => Promise.reject(new ApiServerError('not configured', 503)),
      async () => RESERVATIONS,
    );
    render(<CalendarSection client={clientWith(get)} t={t} />);

    expect(await screen.findByText(t('calendar.sync.unavailable'))).toBeDefined();
    expect(screen.queryByLabelText(t('calendar.sync.urlLabel'))).toBeNull();
  });
});

/**
 * Component tests for `<CalendarSection />` (issue #719).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiServerError, type ApiClient } from '../../../lib/api/client';
import { createTranslator } from '../../../lib/i18n/t';

import { CalendarSection } from './CalendarSection';

const t = createTranslator('fr');

const WEBCAL = 'webcal://api.athlya.test/v1/calendar/feed.ics?token=abc.def';

function clientWith(get: ApiClient['get']): ApiClient {
  return { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() } as unknown as ApiClient;
}

function routes(feed: () => Promise<unknown>) {
  return vi.fn(async (path: string) => {
    if (path === '/v1/calendar/feed-url') return feed();
    throw new Error(`unexpected ${path}`);
  }) as unknown as ApiClient['get'];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<CalendarSection />', () => {
  it('shows the webcal URL and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const get = routes(async () => ({
      httpsUrl: WEBCAL.replace('webcal:', 'https:'),
      webcalUrl: WEBCAL,
    }));
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
  });

  it('reads only the feed URL, not the bookings listed elsewhere on the page', async () => {
    const get = routes(async () => ({ httpsUrl: '', webcalUrl: WEBCAL }));
    render(<CalendarSection client={clientWith(get)} t={t} />);

    await screen.findByLabelText(t('calendar.sync.urlLabel'));
    expect(vi.mocked(get).mock.calls.map(([path]) => path)).toEqual(['/v1/calendar/feed-url']);
    expect(screen.queryByRole('group', { name: t('calendar.add.label') })).toBeNull();
  });

  it('reports a copy failure so the member can copy by hand', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    const get = routes(async () => ({ httpsUrl: '', webcalUrl: WEBCAL }));
    render(<CalendarSection client={clientWith(get)} t={t} />);

    const copy = await screen.findByRole('button', { name: t('calendar.sync.copy') });
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toBe(t('calendar.sync.copyError'));
  });

  it('hides the URL when the feed is not configured', async () => {
    const get = routes(async () => Promise.reject(new ApiServerError('not configured', 503)));
    render(<CalendarSection client={clientWith(get)} t={t} />);

    const unavailable = await screen.findByText(t('calendar.sync.unavailable'));
    expect(unavailable.getAttribute('role')).toBe('status');
    expect(screen.queryByLabelText(t('calendar.sync.urlLabel'))).toBeNull();
  });
});

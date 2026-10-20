import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { ApiError } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { UpcomingBookings } from './UpcomingBookings';

import type { ApiClient } from '../../../lib/api/client';

const t = createTranslator('fr');
const NOW = new Date('2026-10-20T08:00:00.000Z');

function reservation(
  id: string,
  title: string,
  startsAt: string,
  status: 'confirmed' | 'waitlist' = 'confirmed',
): Record<string, unknown> {
  return {
    id,
    classId: `class-${id}`,
    userId: 'user-1',
    status,
    createdAt: '2026-10-01T09:00:00.000Z',
    cancelledAt: null,
    checkedInAt: null,
    class: { id: `class-${id}`, title, startsAt, durationMin: 60 },
  };
}

const LATER = reservation('r1', 'Yoga Vinyasa', '2026-10-21T16:30:00.000Z');
const SOON = reservation('r2', 'Boxe fitness', '2026-10-20T09:00:00.000Z', 'waitlist');

function client(
  items: Record<string, unknown>[],
  del: ApiClient['del'] = vi.fn().mockResolvedValue({ status: 'cancelled' }),
): ApiClient & { readonly get: ReturnType<typeof vi.fn>; readonly del: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue({ items, nextCursor: null }),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(del),
  } as unknown as ApiClient & {
    readonly get: ReturnType<typeof vi.fn>;
    readonly del: ReturnType<typeof vi.fn>;
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function renderBookings(api: ApiClient): Promise<void> {
  render(
    <LocaleProvider locale="fr">
      <UpcomingBookings client={api} t={t} />
    </LocaleProvider>,
  );
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  toastMock.success.mockReset();
});

describe('<UpcomingBookings />', () => {
  it('reads the reservations whose class may still be running', async () => {
    const api = client([]);
    await renderBookings(api);

    const path = new URL(String(api.get.mock.calls[0]?.[0]), 'https://api.test');
    expect(path.pathname).toBe('/v1/reservations/me');
    expect(path.searchParams.get('from')).toBe('2026-10-20T00:00:00.000Z');
  });

  it('shows the empty state with one action to the classes', async () => {
    await renderBookings(client([]));

    expect(screen.getByText(t('classes.upcoming.empty'))).toBeDefined();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(t('web.home.classes'));
    expect(links[0]?.getAttribute('href')).toBe('/classes');
  });

  it('lists the bookings soonest first with their state, and closes cancel 2 h before', async () => {
    await renderBookings(client([LATER, SOON]));

    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
      'Boxe fitness',
      'Yoga Vinyasa',
    ]);
    expect(rows[0]?.textContent).toContain(t('classes.upcoming.waitlist'));
    expect(rows[0]?.textContent).toContain(t('classes.upcoming.cancelClosed'));
    expect(rows[1]?.textContent).toContain(t('classes.upcoming.confirmed'));
    expect(
      screen.getAllByRole('button', { name: (n) => n.startsWith('Annuler la réservation') }),
    ).toHaveLength(1);
  });

  it('cancels after a confirmation, removes the row and announces it', async () => {
    const api = client([LATER]);
    await renderBookings(api);

    fireEvent.click(
      screen.getByRole('button', {
        name: t('classes.upcoming.cancelLabel', { title: 'Yoga Vinyasa' }),
      }),
    );
    const confirm = screen.getByRole('button', { name: t('classes.upcoming.confirmCancel') });
    expect(document.activeElement).toBe(confirm);
    expect(api.del).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await settle();

    expect(api.del).toHaveBeenCalledTimes(1);
    const [path, init] = api.del.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(path).toBe('/v1/reservations/r1');
    expect(init.headers['Idempotency-Key']).toBeDefined();
    expect(screen.queryByText('Yoga Vinyasa')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(t('reservations.cancelled'));
    expect(toastMock.success).toHaveBeenCalledWith(t('reservations.cancelled'));
  });

  it('keeps the booking when the member changes their mind', async () => {
    const api = client([LATER]);
    await renderBookings(api);

    fireEvent.click(
      screen.getByRole('button', { name: (n) => n.startsWith('Annuler la réservation') }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('classes.upcoming.keep') }));

    expect(api.del).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: (n) => n.startsWith('Annuler la réservation') }),
    );
  });

  it('shows the API refusal on the row when the window closed meanwhile', async () => {
    const api = client(
      [LATER],
      vi.fn().mockRejectedValue(
        new ApiError('closed', 422, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          code: 'cancellation_window_closed',
        }),
      ),
    );
    await renderBookings(api);

    fireEvent.click(
      screen.getByRole('button', { name: (n) => n.startsWith('Annuler la réservation') }),
    );
    fireEvent.click(screen.getByRole('button', { name: t('classes.upcoming.confirmCancel') }));
    await settle();

    expect(screen.getByRole('alert').textContent).toBe(t('reservations.cancelWindowClosed'));
    expect(screen.getByText('Yoga Vinyasa')).toBeDefined();
  });

  it('offers a retry when the list cannot be read', async () => {
    const api = client([]);
    api.get.mockRejectedValueOnce(new Error('network down'));
    await renderBookings(api);

    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    await settle();

    expect(screen.getByText(t('classes.upcoming.empty'))).toBeDefined();
  });
});

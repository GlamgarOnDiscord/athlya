/**
 * Component tests for `<CardioProgressionSection />` (issue #683, web).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiServerError } from '../../../lib/api/client';
import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { CardioProgressionSection } from './CardioProgressionSection';

import type { ApiClient } from '../../../lib/api/client';
import type { CardioProgressionResponse } from '@athlya/shared/schemas/api';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('en');

const CARDIO: CardioProgressionResponse = {
  windowDays: 90,
  from: '2026-07-18T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  bucket: 'week',
  totals: { sessions: 3, durationSec: 7500, distanceM: 30500, energyKcal: 900 },
  machines: [
    {
      machine: 'rower',
      sessionCount: 2,
      totals: { durationSec: 4500, distanceM: 12500, energyKcal: 500 },
      series: [
        {
          periodStart: '2026-09-28',
          sessions: 1,
          durationSec: 2400,
          distanceM: 6000,
          energyKcal: 260,
          avgPowerW: 180,
          avgHeartRateBpm: 140,
        },
        {
          periodStart: '2026-10-05',
          sessions: 1,
          durationSec: 2100,
          distanceM: 6500,
          energyKcal: 240,
          avgPowerW: 190,
          avgHeartRateBpm: null,
        },
        {
          periodStart: '2026-10-12',
          sessions: 0,
          durationSec: 0,
          distanceM: 0,
          energyKcal: 0,
          avgPowerW: null,
          avgHeartRateBpm: null,
        },
      ],
      points: [
        {
          startedAt: '2026-10-01T07:00:00.000Z',
          durationSec: 2400,
          distanceM: 6000,
          avgPowerW: 180,
          avgSpeedKmh: 9,
          avgHeartRateBpm: 140,
        },
        {
          startedAt: '2026-10-08T07:00:00.000Z',
          durationSec: 2100,
          distanceM: 6500,
          avgPowerW: 190,
          avgSpeedKmh: null,
          avgHeartRateBpm: null,
        },
      ],
    },
    {
      machine: 'treadmill',
      sessionCount: 1,
      totals: { durationSec: 3000, distanceM: 0, energyKcal: 400 },
      series: [
        {
          periodStart: '2026-10-05',
          sessions: 1,
          durationSec: 3000,
          distanceM: 0,
          energyKcal: 400,
          avgPowerW: null,
          avgHeartRateBpm: null,
        },
      ],
      points: [
        {
          startedAt: '2026-10-06T18:00:00.000Z',
          durationSec: 3000,
          distanceM: null,
          avgPowerW: null,
          avgSpeedKmh: null,
          avgHeartRateBpm: null,
        },
      ],
    },
  ],
  truncated: false,
  skippedSessions: 0,
};

const EMPTY: CardioProgressionResponse = {
  ...CARDIO,
  totals: { sessions: 0, durationSec: 0, distanceM: 0, energyKcal: 0 },
  machines: [],
};

function fakeClient(get: ApiClient['get']): ApiClient {
  return { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() } as unknown as ApiClient;
}

function wrap(children: ReactNode): ReactElement {
  return <LocaleProvider locale="en">{children}</LocaleProvider>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
});

describe('<CardioProgressionSection />', () => {
  it('renders the distance bars and the power and speed trends of the first machine', async () => {
    const get = vi.fn().mockResolvedValue(CARDIO);
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    expect(screen.getByText(t('common.loading'))).toBeDefined();
    await flush();

    expect(get).toHaveBeenCalledWith('/v1/me/progression/cardio?window=90&bucket=week');
    expect(
      screen.getByRole('figure', {
        name: t('workouts.progression.cardio.distance.titleWeek', { machine: 'Rower' }),
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('figure', {
        name: t('workouts.progression.cardio.power.title', { machine: 'Rower' }),
      }),
    ).toBeDefined();
    const speed = screen.getByRole('figure', {
      name: t('workouts.progression.cardio.speed.title', { machine: 'Rower' }),
    });
    // Each value is a focusable mark with a text label, plus a table row.
    expect(screen.getByRole('img', { name: 'Week of Sep 28, 2026: 6 km' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Week of Oct 12, 2026: 0 km' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Oct 8, 2026: 190 W' })).toBeDefined();
    // The session without a speed is left out of the speed trend.
    expect(within(speed).getAllByRole('img')).toHaveLength(1);
    expect(within(speed).getByRole('img', { name: 'Oct 1, 2026: 9 km/h' })).toBeDefined();
    expect(within(speed).getByRole('table')).toBeDefined();
    expect(screen.getByText('12.5 km')).toBeDefined();
    expect(screen.getByText('1 h 15 min')).toBeDefined();
    expect(screen.getByText('500 kcal')).toBeDefined();
  });

  it('moves the keyboard focus between the marks of a chart', async () => {
    const get = vi.fn().mockResolvedValue(CARDIO);
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    const power = screen.getByRole('figure', {
      name: t('workouts.progression.cardio.power.title', { machine: 'Rower' }),
    });
    const [first, last] = within(power).getAllByRole('img');
    expect(last?.getAttribute('tabindex')).toBe('0');
    expect(first?.getAttribute('tabindex')).toBe('-1');
    act(() => {
      last?.focus();
    });
    fireEvent.keyDown(last as Element, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('switches machine and explains the metrics it did not report', async () => {
    const get = vi.fn().mockResolvedValue(CARDIO);
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    fireEvent.change(screen.getByLabelText(t('workouts.progression.cardio.machine')), {
      target: { value: 'treadmill' },
    });

    expect(screen.getByText(t('workouts.progression.cardio.distance.empty'))).toBeDefined();
    expect(screen.getByText(t('workouts.progression.cardio.power.empty'))).toBeDefined();
    expect(screen.getByText(t('workouts.progression.cardio.speed.empty'))).toBeDefined();
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('refetches by day when the daily grouping is picked, and on a window change', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(CARDIO)
      .mockResolvedValue({ ...CARDIO, bucket: 'day' });
    const { rerender } = render(
      wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />),
    );
    await flush();

    fireEvent.click(
      screen.getByRole('radio', { name: t('workouts.progression.cardio.bucket.day') }),
    );
    await flush();
    expect(get).toHaveBeenLastCalledWith('/v1/me/progression/cardio?window=90&bucket=day');
    expect(
      screen.getByRole('figure', {
        name: t('workouts.progression.cardio.distance.titleDay', { machine: 'Rower' }),
      }),
    ).toBeDefined();

    rerender(wrap(<CardioProgressionSection windowDays="30" client={fakeClient(get)} t={t} />));
    await flush();
    expect(get).toHaveBeenLastCalledWith('/v1/me/progression/cardio?window=30&bucket=day');
  });

  it('shows the empty state when no cardio session was recorded', async () => {
    const get = vi.fn().mockResolvedValue(EMPTY);
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('workouts.progression.cardio.empty'))).toBeDefined();
    expect(screen.queryByRole('figure')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the section as unavailable, not as an error, on a 404 from an older API', async () => {
    const get = vi.fn().mockRejectedValue(new ApiError('Not Found', 404));
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('workouts.progression.cardio.unavailable'))).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: t('common.retry') })).toBeNull();
  });

  it('shows an alert with a retry button on failure', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiServerError('Internal Server Error', 500))
      .mockResolvedValue(CARDIO);
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText(t('workouts.progression.cardio.unavailable'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('figure')).toHaveLength(3);
  });

  it('treats a body that does not match the contract as an error', async () => {
    const get = vi.fn().mockResolvedValue({ ...CARDIO, machines: 'nope' });
    render(wrap(<CardioProgressionSection windowDays="90" client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByRole('alert')).toBeDefined();
  });
});

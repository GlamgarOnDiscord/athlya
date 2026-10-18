/**
 * Component tests for `<ProgressionPanel />` (task 22.2, web).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../../lib/i18n/LocaleContext';
import { createTranslator } from '../../../lib/i18n/t';

import { ProgressionPanel } from './ProgressionPanel';

import type { ApiClient } from '../../../lib/api/client';
import type { ProgressionResponse } from '@athlya/shared/schemas/api';
import type { ReactElement, ReactNode } from 'react';

const t = createTranslator('en');

const PROGRESSION: ProgressionResponse = {
  windowDays: 90,
  from: '2026-07-18T00:00:00.000Z',
  to: '2026-10-16T00:00:00.000Z',
  totals: { sessions: 3, volumeKg: 1860 },
  exercises: [
    {
      key: 'back squat',
      name: 'Back squat',
      sessionCount: 2,
      totalVolumeKg: 1860,
      bestEstimatedOneRepMaxKg: 130,
      points: [
        { date: '2026-10-01', volumeKg: 960, estimatedOneRepMaxKg: 130 },
        { date: '2026-10-08', volumeKg: 900, estimatedOneRepMaxKg: null },
      ],
    },
    {
      key: 'pull-up',
      name: 'Pull-up',
      sessionCount: 1,
      totalVolumeKg: 0,
      bestEstimatedOneRepMaxKg: null,
      points: [{ date: '2026-10-01', volumeKg: 0, estimatedOneRepMaxKg: null }],
    },
  ],
  weeklyFrequency: [
    { weekStart: '2026-09-28', sessions: 2 },
    { weekStart: '2026-10-05', sessions: 1 },
    { weekStart: '2026-10-12', sessions: 0 },
  ],
  truncated: false,
  skippedSessions: 0,
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

describe('<ProgressionPanel />', () => {
  it('loads the 90-day window by default and renders the three charts', async () => {
    const get = vi.fn().mockResolvedValue(PROGRESSION);
    render(wrap(<ProgressionPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(get).toHaveBeenCalledWith('/v1/me/progression?window=90');
    expect(
      screen.getByRole('figure', {
        name: t('workouts.progression.volume.title', { exercise: 'Back squat' }),
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('figure', {
        name: t('workouts.progression.oneRepMax.title', { exercise: 'Back squat' }),
      }),
    ).toBeDefined();
    expect(
      screen.getByRole('figure', { name: t('workouts.progression.frequency.title') }),
    ).toBeDefined();
    // Only the day with a qualifying set feeds the 1RM line.
    expect(screen.getByRole('img', { name: 'Oct 1, 2026: 130 kg' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Week of Sep 28, 2026: 2 sessions' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Week of Oct 5, 2026: 1 session' })).toBeDefined();
  });

  it('refetches when another window is selected', async () => {
    const get = vi.fn().mockResolvedValue(PROGRESSION);
    render(wrap(<ProgressionPanel client={fakeClient(get)} t={t} />));
    await flush();

    fireEvent.click(screen.getByRole('radio', { name: t('workouts.progression.window.d365') }));
    await flush();

    expect(get).toHaveBeenLastCalledWith('/v1/me/progression?window=365');
  });

  it('switches exercise and explains when it has no weighted sets', async () => {
    const get = vi.fn().mockResolvedValue(PROGRESSION);
    render(wrap(<ProgressionPanel client={fakeClient(get)} t={t} />));
    await flush();

    fireEvent.change(screen.getByLabelText(t('workouts.progression.exercise')), {
      target: { value: 'pull-up' },
    });

    expect(screen.getByText(t('workouts.progression.noWeight'))).toBeDefined();
    expect(screen.getByText(t('workouts.progression.oneRepMax.empty'))).toBeDefined();
  });

  it('shows the empty state when no session was logged', async () => {
    const get = vi.fn().mockResolvedValue({
      ...PROGRESSION,
      totals: { sessions: 0, volumeKg: 0 },
      exercises: [],
    });
    render(wrap(<ProgressionPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByText(t('workouts.progression.empty'))).toBeDefined();
  });

  it('shows an alert with a retry button on failure', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(PROGRESSION);
    render(wrap(<ProgressionPanel client={fakeClient(get)} t={t} />));
    await flush();

    expect(screen.getByRole('alert')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

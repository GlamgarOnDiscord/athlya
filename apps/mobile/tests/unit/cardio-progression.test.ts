import { describe, expect, it, vi } from 'vitest';

import { formatNumber, formatUtcDay } from '../../features/format';
import {
  distanceSeries,
  distanceSummary,
  powerSeries,
  speedSeries,
  trendSummary,
} from '../../features/progression/cardio-progression-charts';
import {
  CARDIO_BUCKETS,
  cardioProgressionPath,
  CardioProgressionController,
  cardioSectionView,
  DEFAULT_BUCKET,
  selectedMachine,
} from '../../features/progression/cardio-progression-controller';
import { layoutChart, type SummaryFormat } from '../../features/progression/progression-charts';
import { type ApiClient, type ApiResponse } from '../../infrastructure/api/client';
import { AuthRequiredError, NetworkError } from '../../infrastructure/api/errors';

import type {
  CardioMachineProgression,
  CardioProgressionBucket,
  CardioProgressionResponse,
  ProgressionWindow,
} from '@athlya/shared/schemas/api';

const ROWER: CardioMachineProgression = {
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
};

const TREADMILL: CardioMachineProgression = {
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
};

function body(
  windowDays: ProgressionWindow = 90,
  bucket: CardioProgressionBucket = 'week',
  machines: CardioMachineProgression[] = [ROWER, TREADMILL],
): CardioProgressionResponse {
  return {
    windowDays,
    from: '2026-07-21T00:00:00.000Z',
    to: '2026-10-19T00:00:00.000Z',
    bucket,
    totals: { sessions: 3, durationSec: 7500, distanceM: 12500, energyKcal: 900 },
    machines,
    truncated: false,
    skippedSessions: 0,
  };
}

function response(status: number, payload: unknown = null, etag?: string): ApiResponse {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (etag !== undefined) headers.set('etag', etag);
  return { status, headers, body: payload };
}

type SendArgs = Parameters<ApiClient['send']>;

function fakeSend() {
  return vi.fn<(...args: SendArgs) => Promise<ApiResponse>>();
}

const FORMAT: SummaryFormat = {
  day: (date) => formatUtcDay(date, 'en'),
  number: (value) => formatNumber(value, 'en'),
};

describe('cardioProgressionPath', () => {
  it('asks for the window in days and the bucket', () => {
    expect(cardioProgressionPath(30, 'day')).toBe('/v1/me/progression/cardio?window=30&bucket=day');
    expect(cardioProgressionPath(365, 'week')).toBe(
      '/v1/me/progression/cardio?window=365&bucket=week',
    );
    expect(DEFAULT_BUCKET).toBe('week');
    expect(CARDIO_BUCKETS).toEqual(['week', 'day']);
  });
});

describe('selectedMachine', () => {
  it('charts the picked machine, else the first one listed', () => {
    const data = body();
    expect(selectedMachine(data, 'treadmill')?.machine).toBe('treadmill');
    expect(selectedMachine(data, null)?.machine).toBe('rower');
    expect(selectedMachine(data, 'indoorBike')?.machine).toBe('rower');
    expect(selectedMachine(body(90, 'week', []), null)).toBeUndefined();
  });
});

describe('cardio section states', () => {
  it('is loading before the first answer', () => {
    const controller = new CardioProgressionController({ send: fakeSend() });
    expect(cardioSectionView(controller.get())).toEqual({ kind: 'loading' });
  });

  it('shows the charts of the first machine when there is data', async () => {
    const send = fakeSend().mockResolvedValue(response(200, body(), '"c1"'));
    const controller = new CardioProgressionController({ send });
    await controller.load();

    expect(send.mock.calls[0]?.slice(0, 3)).toEqual([
      'GET',
      '/v1/me/progression/cardio?window=90&bucket=week',
      undefined,
    ]);
    const view = cardioSectionView(controller.get());
    expect(view).toMatchObject({ kind: 'data', machine: { machine: 'rower' }, error: null });

    controller.selectMachine('treadmill');
    expect(cardioSectionView(controller.get())).toMatchObject({
      kind: 'data',
      machine: { machine: 'treadmill' },
    });
  });

  it('shows the empty state when no cardio session was recorded', async () => {
    const send = fakeSend().mockResolvedValue(response(200, body(90, 'week', [])));
    const controller = new CardioProgressionController({ send });
    await controller.load();
    expect(cardioSectionView(controller.get()).kind).toBe('empty');
  });

  it('shows the section as unavailable, not as an error, on a 404 from an older API', async () => {
    const send = fakeSend().mockResolvedValue(
      response(404, { type: 'about:blank', title: 'Not Found', status: 404 }),
    );
    const controller = new CardioProgressionController({ send });
    await controller.load();

    expect(controller.get()).toMatchObject({ load: 'unavailable', error: null, data: null });
    expect(cardioSectionView(controller.get())).toEqual({ kind: 'unavailable' });
  });

  it('shows the error on other failures', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(500, { type: 'about:blank', title: 'Boom', status: 500 }))
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockRejectedValueOnce(new AuthRequiredError());
    const controller = new CardioProgressionController({ send });

    await controller.load();
    expect(cardioSectionView(controller.get())).toEqual({
      kind: 'error',
      error: { key: 'errors.generic', authRequired: false },
    });
    await controller.load();
    expect(cardioSectionView(controller.get())).toEqual({
      kind: 'error',
      error: { key: 'errors.network', authRequired: false },
    });
    await controller.load();
    expect(cardioSectionView(controller.get())).toEqual({
      kind: 'error',
      error: { key: 'mobile.errors.sessionExpired', authRequired: true },
    });
  });

  it('keeps the last body on screen under the error when a revalidation fails', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(), '"c1"'))
      .mockRejectedValueOnce(new NetworkError('offline'));
    const controller = new CardioProgressionController({ send });
    await controller.load();
    await controller.load();
    expect(cardioSectionView(controller.get())).toMatchObject({
      kind: 'data',
      error: { key: 'errors.network' },
    });
  });
});

describe('CardioProgressionController', () => {
  it('revalidates with If-None-Match and keeps the cached body on 304', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(), '"c1"'))
      .mockResolvedValueOnce(response(304));
    const controller = new CardioProgressionController({ send });
    await controller.load();
    const first = controller.get().data;
    await controller.load();

    expect(send.mock.calls[1]?.[3]?.headers).toEqual({ 'If-None-Match': '"c1"' });
    expect(controller.get().data).toBe(first);
  });

  it('caches each window and bucket separately', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, body(90, 'week'), '"w"'))
      .mockResolvedValueOnce(response(200, body(90, 'day'), '"d"'))
      .mockResolvedValueOnce(response(200, body(30, 'day'), '"d30"'))
      .mockResolvedValueOnce(response(304));
    const controller = new CardioProgressionController({ send });
    await controller.load();
    await controller.selectBucket('day');
    expect(send.mock.calls[1]?.[1]).toBe('/v1/me/progression/cardio?window=90&bucket=day');
    expect(send.mock.calls[1]?.[3]?.headers).toBeUndefined();
    await controller.selectWindow(30);
    expect(send.mock.calls[2]?.[1]).toBe('/v1/me/progression/cardio?window=30&bucket=day');

    const switching = controller.selectWindow(90);
    expect(controller.get()).toMatchObject({ load: 'loading', windowDays: 90, bucket: 'day' });
    expect(controller.get().data).toMatchObject({ windowDays: 90, bucket: 'day' });
    expect(send.mock.calls[3]?.[3]?.headers).toEqual({ 'If-None-Match': '"d"' });
    await switching;
    expect(controller.get()).toMatchObject({ load: 'ready', windowDays: 90, bucket: 'day' });
  });

  it('rejects an invalid body and a mismatched window or bucket', async () => {
    const send = fakeSend()
      .mockResolvedValueOnce(response(200, { ...body(), machines: 'nope' }))
      .mockResolvedValueOnce(response(200, body(365)))
      .mockResolvedValueOnce(response(200, body(90, 'day')));
    const controller = new CardioProgressionController({ send });
    for (let i = 0; i < 3; i += 1) {
      await controller.load();
      expect(controller.get()).toMatchObject({
        load: 'error',
        data: null,
        error: { key: 'errors.generic', authRequired: false },
      });
    }
  });

  it('cancel() ignores the answer of the load in flight', async () => {
    let resolve!: (value: ApiResponse) => void;
    const send = fakeSend().mockReturnValueOnce(
      new Promise<ApiResponse>((res) => {
        resolve = res;
      }),
    );
    const controller = new CardioProgressionController({ send });
    const loading = controller.load();
    controller.cancel();
    resolve(response(200, body()));
    await loading;
    expect(controller.get().data).toBeNull();
  });
});

describe('cardio chart models', () => {
  it('reads the distance in km per bucket and the session trends', () => {
    expect(distanceSeries(ROWER).map((point) => [point.date, point.value])).toEqual([
      ['2026-09-28', 6],
      ['2026-10-05', 6.5],
      ['2026-10-12', 0],
    ]);
    expect(powerSeries(ROWER).map((point) => [point.date, point.value])).toEqual([
      ['2026-10-01', 180],
      ['2026-10-08', 190],
    ]);
    // The session without a speed is left out.
    expect(speedSeries(ROWER).map((point) => point.value)).toEqual([9]);
    expect(powerSeries(TREADMILL)).toEqual([]);
    expect(new Set(powerSeries(ROWER).map((point) => point.key)).size).toBe(2);
  });

  it('lays the distance out as bars and the trends as lines', () => {
    const bars = layoutChart({ kind: 'bar', points: distanceSeries(ROWER), width: 320 });
    expect(bars.bars).toHaveLength(3);
    const line = layoutChart({
      kind: 'line',
      points: powerSeries(ROWER),
      width: 320,
      xDomain: [Date.parse('2026-07-21T00:00:00.000Z'), Date.parse('2026-10-19T00:00:00.000Z')],
    });
    expect(line.line).not.toBeNull();
    expect(line.showMarkers).toBe(true);
  });

  it('summarises each chart for screen readers, with units in the message', () => {
    expect(distanceSummary(distanceSeries(ROWER), FORMAT)).toEqual({
      key: 'mobile.progression.cardio.distanceSummary',
      values: {
        count: 3,
        from: FORMAT.day('2026-09-28'),
        to: FORMAT.day('2026-10-12'),
        total: '12.5',
        max: '6.5',
        latest: '0',
      },
    });
    expect(distanceSummary(distanceSeries(TREADMILL), FORMAT)).toBeNull();
    expect(
      trendSummary(powerSeries(ROWER), FORMAT, 'mobile.progression.cardio.powerSummary'),
    ).toEqual({
      key: 'mobile.progression.cardio.powerSummary',
      values: {
        count: 2,
        from: FORMAT.day('2026-10-01'),
        to: FORMAT.day('2026-10-08'),
        latest: '190',
        max: '190',
        min: '180',
      },
    });
    expect(
      trendSummary(speedSeries(TREADMILL), FORMAT, 'mobile.progression.cardio.speedSummary'),
    ).toBeNull();
  });
});

import { createTranslator } from '@athlya/shared/i18n';
import { LogSessionRequestSchema } from '@athlya/shared/schemas/api';
import { describe, expect, it } from 'vitest';

import { formatElapsed, liveMetricRows } from '../../features/ftms/live-metrics';
import {
  addSample,
  createLiveSession,
  MAX_GAP_MS,
  summarise,
  type LiveSession,
} from '../../features/ftms/live-session';
import {
  buildMachineSessionRequest,
  describeSummary,
  saveMachineSession,
} from '../../features/ftms/machine-workout';
import { LOG_SESSION_KIND, SESSIONS_PATH } from '../../features/workouts/workout-form';
import { NetworkError } from '../../infrastructure/api/errors';
import { base64ToBytes } from '../../infrastructure/ble/base64';
import { createWriteDeps } from '../features-helpers';
import { OWNER } from '../helpers';

import type { FtmsSample } from '../../features/ftms/protocol';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const en = createTranslator('en');
const fr = createTranslator('fr');

function feed(session: LiveSession, samples: readonly (readonly [number, FtmsSample])[]) {
  return samples.reduce((current, [at, sample]) => addSample(current, sample, T0 + at), session);
}

describe('live session', () => {
  it('merges partial samples and keeps the latest value per metric', () => {
    const session = feed(createLiveSession('indoorBike', T0), [
      [0, { speedKmh: 30, powerW: 200 }],
      [500, { cadenceRpm: 90 }],
      [1_000, { powerW: 220 }],
    ]);
    expect(session.latest).toEqual({ speedKmh: 30, powerW: 220, cadenceRpm: 90 });
    expect(session.samples).toBe(3);
    expect(session.maxPowerW).toBe(220);
  });

  it('time-weights averages and does not integrate long gaps', () => {
    const session = feed(createLiveSession('indoorBike', T0), [
      [0, { powerW: 100, heartRateBpm: 120 }],
      [3_000, { powerW: 300, heartRateBpm: 150 }],
      [4_000, { powerW: 300 }],
      // Paused: the gap is longer than MAX_GAP_MS and is skipped.
      [4_000 + MAX_GAP_MS + 1, { powerW: 0 }],
    ]);
    const summary = summarise(session, T0 + 20_000);
    // 100 W for 3 s, then 300 W for 1 s.
    expect(summary.avgPowerW).toBe(150);
    expect(summary.maxPowerW).toBe(300);
    expect(summary.avgHeartRateBpm).toBe(128);
    expect(summary.maxHeartRateBpm).toBe(150);
    expect(session.integratedMs).toBe(4_000);
  });

  it('ignores out-of-order notifications for integration', () => {
    const session = feed(createLiveSession('indoorBike', T0), [
      [2_000, { powerW: 100 }],
      [1_000, { powerW: 400 }],
    ]);
    expect(session.integratedMs).toBe(0);
    expect(session.lastSampleAtMs).toBe(T0 + 2_000);
  });

  it('integrates speed into distance when the machine reports none', () => {
    const session = feed(createLiveSession('treadmill', T0), [
      [0, { speedKmh: 36 }],
      [1_000, { speedKmh: 36 }],
      [2_000, { speedKmh: 36 }],
    ]);
    expect(summarise(session, T0 + 2_000).distanceM).toBe(20);
  });

  it('prefers machine totals over phone-side values', () => {
    const session = feed(createLiveSession('rower', T0), [
      [0, { strokeRatePerMin: 28, distanceM: 1_500, elapsedSec: 400, energyKcal: 60 }],
      [1_000, { strokeCount: 180 }],
    ]);
    const summary = summarise(session, T0 + 1_000);
    expect(summary.distanceM).toBe(1_500);
    expect(summary.elapsedSec).toBe(400);
    expect(summary.energyKcal).toBe(60);
    expect(summary.strokeCount).toBe(180);
    // The workout began on the console before the phone connected.
    expect(summary.startedAtMs).toBe(T0 + 1_000 - 400_000);
  });

  it('falls back to wall-clock time', () => {
    const session = feed(createLiveSession('indoorBike', T0), [
      [0, { powerW: 100 }],
      [125_000, { powerW: 100 }],
    ]);
    const summary = summarise(session, T0 + 130_000);
    expect(summary.elapsedSec).toBe(125);
    expect(summary.startedAtMs).toBe(T0);
    expect(summary.distanceM).toBeNull();
  });
});

describe('machine workout', () => {
  const summary = summarise(
    feed(createLiveSession('indoorBike', T0), [
      [0, { powerW: 180, cadenceRpm: 88, heartRateBpm: 140, distanceM: 5_230 }],
      [1_000, { energyKcal: 250, elapsedSec: 1_830 }],
    ]),
    T0 + 1_000,
  );

  it('describes the reported metrics in the member locale', () => {
    expect(describeSummary(summary, en, 'en')).toBe(
      'Distance 5.2 km · Avg power 180 W · Max power 180 W · Avg cadence 88 rpm · 250 kcal · Avg heart rate 140 bpm',
    );
    expect(describeSummary(summary, fr, 'fr')).toContain('Distance 5,2 km');
  });

  it('builds a schema-valid workout request', () => {
    const request = buildMachineSessionRequest(summary, en, 'en');
    expect(request).not.toBeNull();
    expect(LogSessionRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({
      startedAt: new Date(T0 + 1_000 - 1_830_000).toISOString(),
      durationMin: 31,
      exercises: [{ name: 'Indoor bike', sets: [{ reps: 0, durationSec: 1_830 }] }],
    });
    expect(request?.notes).toContain('Avg power 180 W');
  });

  it('logs at least one minute, caps the set duration, and skips empty sessions', () => {
    const short = { ...summary, elapsedSec: 20 };
    expect(buildMachineSessionRequest(short, en, 'en')?.durationMin).toBe(1);
    const long = { ...summary, elapsedSec: 100_000 };
    expect(buildMachineSessionRequest(long, en, 'en')?.exercises[0]?.sets[0]?.durationSec).toBe(
      86_400,
    );
    expect(buildMachineSessionRequest({ ...summary, elapsedSec: 0 }, en, 'en')).toBeNull();
  });

  it('sends the session online and queues it offline', async () => {
    const request = buildMachineSessionRequest(summary, en, 'en');
    const online = createWriteDeps();
    online.api.post.mockResolvedValue({});
    await expect(saveMachineSession(online.deps, request)).resolves.toEqual({ kind: 'sent' });
    expect(online.api.post).toHaveBeenCalledWith(SESSIONS_PATH, request, expect.anything());

    const offline = createWriteDeps();
    offline.api.post.mockRejectedValue(new NetworkError('offline'));
    await expect(saveMachineSession(offline.deps, request)).resolves.toEqual({ kind: 'queued' });
    const [queued] = offline.queue.pendingFor(OWNER);
    expect(queued?.kind).toBe(LOG_SESSION_KIND);
  });

  it('reports an empty session without writing', async () => {
    const { deps, api } = createWriteDeps();
    await expect(saveMachineSession(deps, null)).resolves.toEqual({ kind: 'empty' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('live metric rows', () => {
  it('lists only reported metrics, formatted', () => {
    const session = feed(createLiveSession('treadmill', T0), [
      [0, { speedKmh: 10.5, inclinePct: 2, heartRateBpm: 150 }],
      [65_000, { distanceM: 11_400 }],
    ]);
    expect(liveMetricRows(session, T0 + 65_000, en, 'en')).toEqual([
      { key: 'elapsed', label: 'Time', value: '1:05' },
      { key: 'speed', label: 'Speed', value: '10.5 km/h' },
      { key: 'incline', label: 'Incline', value: '2 %' },
      { key: 'distance', label: 'Distance', value: '11.4 km' },
      { key: 'heartRate', label: 'Heart rate', value: '150 bpm' },
    ]);
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(605)).toBe('10:05');
    expect(formatElapsed(3_723)).toBe('1:02:03');
  });
});

describe('base64ToBytes', () => {
  it('matches Node for arbitrary payloads', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 19, 20]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      expect(base64ToBytes(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
    }
  });

  it('rejects invalid input', () => {
    expect(base64ToBytes('a')).toBeNull();
    expect(base64ToBytes('ab$d')).toBeNull();
  });
});

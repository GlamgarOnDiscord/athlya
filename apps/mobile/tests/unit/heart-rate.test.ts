import { createTranslator } from '@athlya/shared/i18n';
import { describe, expect, it } from 'vitest';

import {
  decodeHeartRateMeasurement,
  pickHeartRateCharacteristic,
  usableHeartRate,
} from '../../features/ftms/heart-rate';
import { liveMetricRows } from '../../features/ftms/live-metrics';
import {
  addHeartRate,
  addSample,
  createLiveSession,
  MAX_GAP_MS,
  releaseHeartRate,
  summarise,
} from '../../features/ftms/live-session';
import { fullUuid } from '../../features/ftms/protocol';
import { hex } from '../ftms-helpers';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const en = createTranslator('en');

describe('Heart Rate Measurement (0x2A37)', () => {
  it('decodes a uint8 heart rate without contact support', () => {
    expect(decodeHeartRateMeasurement(hex('00 48'))).toEqual({
      bpm: 72,
      contact: 'unsupported',
      energyExpendedKj: null,
      rrIntervalsMs: [],
    });
  });

  it('decodes a uint16 heart rate', () => {
    expect(decodeHeartRateMeasurement(hex('01 2c01'))?.bpm).toBe(300);
  });

  it('reports sensor contact', () => {
    expect(decodeHeartRateMeasurement(hex('06 8c'))?.contact).toBe('detected');
    expect(decodeHeartRateMeasurement(hex('04 8c'))?.contact).toBe('notDetected');
    // Bit 1 without bit 2 (contact not supported) means nothing.
    expect(decodeHeartRateMeasurement(hex('02 8c'))?.contact).toBe('unsupported');
  });

  it('decodes energy expended and RR-intervals', () => {
    // Flags 0x1E: contact detected (1, 2), energy (3), RR (4); 140 bpm,
    // 312 kJ, RR 1024/1024 s and 768/1024 s.
    expect(decodeHeartRateMeasurement(hex('1e 8c 3801 0004 0003'))).toEqual({
      bpm: 140,
      contact: 'detected',
      energyExpendedKj: 312,
      rrIntervalsMs: [1000, 750],
    });
  });

  it('decodes RR-intervals after a uint16 heart rate', () => {
    expect(decodeHeartRateMeasurement(hex('11 9600 0002'))).toMatchObject({
      bpm: 150,
      rrIntervalsMs: [500],
    });
  });

  it('ignores an odd trailing byte and bytes the flags do not announce', () => {
    expect(decodeHeartRateMeasurement(hex('10 8c 0004 ff'))?.rrIntervalsMs).toEqual([1000]);
    expect(decodeHeartRateMeasurement(hex('00 8c 0004'))).toMatchObject({
      bpm: 140,
      rrIntervalsMs: [],
    });
  });

  it('rejects packets shorter than their flags announce', () => {
    expect(decodeHeartRateMeasurement(hex(''))).toBeNull();
    expect(decodeHeartRateMeasurement(hex('00'))).toBeNull();
    expect(decodeHeartRateMeasurement(hex('01 8c'))).toBeNull();
    expect(decodeHeartRateMeasurement(hex('08 8c 38'))).toBeNull();
  });

  it('keeps only readings taken with skin contact', () => {
    const reading = (bytes: string) => {
      const decoded = decodeHeartRateMeasurement(hex(bytes));
      return decoded === null ? undefined : usableHeartRate(decoded);
    };
    expect(reading('06 8c')).toBe(140);
    expect(reading('00 8c')).toBe(140);
    expect(reading('04 8c')).toBeNull();
    expect(reading('06 00')).toBeNull();
  });

  it('finds the measurement characteristic in any UUID form', () => {
    expect(
      pickHeartRateCharacteristic([fullUuid(0x2a38), '00002A37-0000-1000-8000-00805F9B34FB']),
    ).toBe('00002A37-0000-1000-8000-00805F9B34FB');
    expect(pickHeartRateCharacteristic(['2a37'])).toBe('2a37');
    expect(pickHeartRateCharacteristic([fullUuid(0x2a38)])).toBeNull();
  });
});

describe('heart-rate merge', () => {
  it('lets the strap win over the machine while it reports', () => {
    let session = createLiveSession('indoorBike', T0);
    session = addSample(session, { powerW: 200, heartRateBpm: 100 }, T0);
    session = addHeartRate(session, 140, T0 + 500);
    session = addSample(session, { powerW: 200, heartRateBpm: 105 }, T0 + 1_000);
    expect(session.heartRateSource).toBe('strap');
    expect(session.latest).toEqual({ powerW: 200, heartRateBpm: 140 });
    // Machine 100 bpm for 500 ms, then the strap's 140 bpm for 1 000 ms.
    session = addHeartRate(session, 140, T0 + 1_500);
    const summary = summarise(session, T0 + 1_500);
    expect(summary.avgHeartRateBpm).toBe(Math.round((100 * 500 + 140 * 1_000) / 1_500));
    expect(summary.maxHeartRateBpm).toBe(140);
    // Power keeps its own timeline: machine samples only.
    expect(summary.avgPowerW).toBe(200);
    expect(session.powerMs).toBe(1_000);
  });

  it('uses the machine again once the strap releases', () => {
    let session = createLiveSession('indoorBike', T0);
    session = addHeartRate(session, 140, T0);
    session = releaseHeartRate(session, T0 + 1_000);
    expect(session.heartRateSource).toBe('machine');
    expect(session.latest.heartRateBpm).toBeUndefined();
    session = addSample(session, { heartRateBpm: 110 }, T0 + 1_500);
    expect(session.latest.heartRateBpm).toBe(110);
    expect(summarise(session, T0 + 1_500).avgHeartRateBpm).toBe(140);
    expect(releaseHeartRate(session, T0 + 2_000)).toBe(session);
  });

  it('falls back to the machine when the strap has been silent too long', () => {
    let session = createLiveSession('treadmill', T0);
    session = addHeartRate(session, 150, T0);
    session = addSample(session, { heartRateBpm: 120 }, T0 + MAX_GAP_MS);
    expect(session.latest.heartRateBpm).toBe(150);
    session = addSample(session, { heartRateBpm: 120 }, T0 + 2 * MAX_GAP_MS + 1);
    expect(session.heartRateSource).toBe('machine');
    expect(session.latest.heartRateBpm).toBe(120);
  });

  it('does not integrate long strap gaps', () => {
    let session = createLiveSession('rower', T0);
    session = addHeartRate(session, 150, T0);
    session = addHeartRate(session, 90, T0 + MAX_GAP_MS + 1);
    expect(session.heartRateMs).toBe(0);
    expect(summarise(session, T0 + MAX_GAP_MS + 1).maxHeartRateBpm).toBe(150);
  });

  it('labels the live heart rate with its source', () => {
    const fromStrap = addHeartRate(createLiveSession('indoorBike', T0), 140, T0);
    const fromMachine = addSample(createLiveSession('indoorBike', T0), { heartRateBpm: 120 }, T0);
    const heartRow = (rows: ReturnType<typeof liveMetricRows>) =>
      rows.find((row) => row.key === 'heartRate');
    expect(heartRow(liveMetricRows(fromStrap, T0, en, 'en'))).toEqual({
      key: 'heartRate',
      label: 'Heart rate (strap)',
      value: '140 bpm',
    });
    expect(heartRow(liveMetricRows(fromMachine, T0, en, 'en'))?.label).toBe('Heart rate');
  });
});

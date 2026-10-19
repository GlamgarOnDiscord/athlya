/**
 * Heart-rate strap properties (issue #669):
 *   - every Heart Rate Measurement built from its flags decodes back to
 *     the values it carries (uint8/uint16, contact, energy, RR-intervals);
 *   - arbitrary bytes never throw: the decoder runs inside the BLE
 *     notification callback;
 *   - merging strap and machine readings keeps the heart-rate average
 *     between the lowest and highest value fed, and the strap's value is
 *     the live one while it reports.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { decodeHeartRateMeasurement } from '../../features/ftms/heart-rate';
import {
  addHeartRate,
  addSample,
  createLiveSession,
  MAX_GAP_MS,
  releaseHeartRate,
  summarise,
  type LiveSession,
} from '../../features/ftms/live-session';

interface Measurement {
  readonly wide: boolean;
  readonly contactBits: number;
  readonly bpm: number;
  readonly energy: number | null;
  readonly rr: readonly number[] | null;
}

const u16 = fc.integer({ min: 0, max: 0xffff });

const measurement: fc.Arbitrary<Measurement> = fc
  .record({ wide: fc.boolean(), contactBits: fc.integer({ min: 0, max: 3 }) })
  .chain(({ wide, contactBits }) =>
    fc.record({
      wide: fc.constant(wide),
      contactBits: fc.constant(contactBits),
      bpm: wide ? u16 : fc.integer({ min: 0, max: 0xff }),
      energy: fc.option(u16, { nil: null }),
      rr: fc.option(fc.array(u16, { maxLength: 9 }), { nil: null }),
    }),
  );

function encode({ wide, contactBits, bpm, energy, rr }: Measurement): Uint8Array {
  const flags =
    (wide ? 0x01 : 0) |
    (contactBits << 1) |
    (energy === null ? 0 : 0x08) |
    (rr === null ? 0 : 0x10);
  const bytes = [flags, ...(wide ? [bpm & 0xff, bpm >> 8] : [bpm])];
  if (energy !== null) bytes.push(energy & 0xff, energy >> 8);
  for (const value of rr ?? []) bytes.push(value & 0xff, value >> 8);
  return Uint8Array.from(bytes);
}

const CONTACT = ['unsupported', 'unsupported', 'notDetected', 'detected'] as const;

type Event =
  | { readonly kind: 'strap'; readonly bpm: number; readonly step: number }
  | { readonly kind: 'machine'; readonly bpm: number | null; readonly step: number }
  | { readonly kind: 'release'; readonly step: number };

const bpm = fc.integer({ min: 30, max: 220 });
const step = fc.integer({ min: -1_000, max: 2 * MAX_GAP_MS });
const event: fc.Arbitrary<Event> = fc.oneof(
  fc.record({ kind: fc.constant('strap' as const), bpm, step }),
  fc.record({ kind: fc.constant('machine' as const), bpm: fc.option(bpm, { nil: null }), step }),
  fc.record({ kind: fc.constant('release' as const), step }),
);

describe('heart-rate decoding properties', () => {
  it('decodes every encoded measurement back to its values', () => {
    fc.assert(
      fc.property(measurement, (input) => {
        expect(decodeHeartRateMeasurement(encode(input))).toEqual({
          bpm: input.bpm,
          contact: CONTACT[input.contactBits],
          energyExpendedKj: input.energy,
          rrIntervalsMs: (input.rr ?? []).map((value) => (value * 1000) / 1024),
        });
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 24 }), (bytes) => {
        const decoded = decodeHeartRateMeasurement(bytes);
        if (decoded === null) return;
        expect(Number.isInteger(decoded.bpm)).toBe(true);
        for (const rr of decoded.rrIntervalsMs) expect(rr).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('heart-rate merge properties', () => {
  it('keeps the average within the fed values and the strap value live', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 40 }), (events) => {
        let session: LiveSession = createLiveSession('indoorBike', 0);
        let at = 0;
        const fed: number[] = [];
        for (const item of events) {
          at += item.step;
          if (item.kind === 'strap') {
            fed.push(item.bpm);
            session = addHeartRate(session, item.bpm, at);
            expect(session.latest.heartRateBpm).toBe(item.bpm);
          } else if (item.kind === 'release') {
            session = releaseHeartRate(session, at);
            expect(session.heartRateSource).toBe('machine');
          } else {
            const strapBefore = session.latest.heartRateBpm;
            const live =
              session.heartRateSource === 'strap' &&
              session.strapAtMs !== null &&
              at - session.strapAtMs <= MAX_GAP_MS;
            if (item.bpm !== null && !live) fed.push(item.bpm);
            session = addSample(
              session,
              item.bpm === null ? { powerW: 100 } : { powerW: 100, heartRateBpm: item.bpm },
              at,
            );
            if (live) expect(session.latest.heartRateBpm).toBe(strapBefore);
          }
        }
        const summary = summarise(session, at);
        expect(session.heartRateMs).toBeGreaterThanOrEqual(0);
        if (summary.avgHeartRateBpm !== null) {
          expect(summary.avgHeartRateBpm).toBeGreaterThanOrEqual(Math.min(...fed));
          expect(summary.avgHeartRateBpm).toBeLessThanOrEqual(Math.max(...fed));
        }
        expect(summary.maxHeartRateBpm).toBe(fed.length === 0 ? null : Math.max(...fed));
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * FTMS decoding properties (task 23.1):
 *   - every packet built from a layout decodes back to the metrics it
 *     carries, in both published layouts (GATT Supplement and FTMS 1.0);
 *   - arbitrary bytes never throw: the decoder runs inside the BLE
 *     notification callback;
 *   - the live session never reports negative or non-finite totals.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addSample, createLiveSession, summarise } from '../../features/ftms/live-session';
import {
  decodeMachineData,
  isFieldPresent,
  MACHINE_LAYOUTS,
  MACHINE_PRIORITY,
  partType,
  type FieldType,
  type FtmsSample,
  type Layout,
  type MachineType,
} from '../../features/ftms/protocol';
import { encodeMachineData } from '../ftms-helpers';

const RANGES: Readonly<Record<FieldType, readonly [number, number]>> = {
  u8: [0, 0xff],
  u16: [0, 0xffff],
  s16: [-0x8000, 0x7fff],
  u24: [0, 0xffffff],
};

interface Packet {
  readonly machine: MachineType;
  readonly layout: Layout;
  readonly flags: number;
  readonly raw: readonly number[];
}

const packet: fc.Arbitrary<Packet> = fc
  .record({
    machine: fc.constantFrom(...MACHINE_PRIORITY),
    layout: fc.constantFrom<Layout>('supplement', 'legacy'),
    flagBits: fc.nat({ max: 0x7fff }),
  })
  .chain(({ machine, layout, flagBits }) => {
    const spec = MACHINE_LAYOUTS[machine];
    const mask = spec.fields.reduce((bits, field) => bits | (1 << field.bit), 0);
    const flags = flagBits & mask;
    const types = spec.fields
      .filter((field) => isFieldPresent(field, flags))
      .flatMap((field) => field.parts.map((part) => partType(part, layout)));
    return fc
      .tuple(...types.map((type) => fc.integer({ min: RANGES[type][0], max: RANGES[type][1] })))
      .map((raw): Packet => ({ machine, layout, flags, raw }));
  });

function expected({ machine, flags, raw }: Packet): FtmsSample {
  const sample: Record<string, number> = {};
  let index = 0;
  for (const field of MACHINE_LAYOUTS[machine].fields) {
    if (!isFieldPresent(field, flags)) continue;
    for (const part of field.parts) {
      const value = raw[index] ?? 0;
      index += 1;
      if (part.metric === undefined || value === part.unavailable) continue;
      sample[part.metric] = Math.round(value * (part.scale ?? 1) * 1000) / 1000;
    }
  }
  return sample;
}

describe('FTMS decoding properties', () => {
  it('decodes every encoded packet back to its metrics, in both layouts', () => {
    fc.assert(
      fc.property(packet, (input) => {
        const bytes = encodeMachineData(input.machine, input.flags, input.raw, input.layout);
        expect(decodeMachineData(input.machine, bytes)).toEqual(expected(input));
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MACHINE_PRIORITY),
        fc.uint8Array({ maxLength: 40 }),
        (machine, bytes) => {
          const sample = decodeMachineData(machine, bytes);
          expect(sample === null || typeof sample === 'object').toBe(true);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('keeps live totals finite and non-negative', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(packet, fc.integer({ min: -2_000, max: 10_000 })), { maxLength: 40 }),
        (events) => {
          let session = createLiveSession('indoorBike', 0);
          let at = 0;
          for (const [input, step] of events) {
            at += step;
            const bytes = encodeMachineData(input.machine, input.flags, input.raw, input.layout);
            const sample = decodeMachineData(input.machine, bytes);
            if (sample !== null) session = addSample(session, sample, at);
          }
          const summary = summarise(session, at);
          for (const value of [
            summary.elapsedSec,
            summary.distanceM,
            summary.avgPowerW,
            summary.avgHeartRateBpm,
            summary.avgCadenceRpm,
          ]) {
            if (value === null) continue;
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
          expect(session.integratedMs).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/**
 * FTMS Control Point properties (issue #668):
 *   - targets round-trip through the request encoders and the Fitness
 *     Machine Status decoder, and response codes through their decoder;
 *   - supported ranges round-trip through their decoder;
 *   - clamping always lands inside the range, on its increment grid, and
 *     leaves a value already there untouched;
 *   - whatever the member asks for, the controller never writes a target
 *     outside the range the machine advertised;
 *   - decoders never throw on arbitrary bytes (they run in BLE callbacks).
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clampToRange,
  decodeControlResponse,
  decodeMachineStatus,
  decodeRange,
  decodeTargetFeatures,
  encodeLegacyTargetResistance,
  encodeTargetPower,
  encodeTargetResistance,
  type ControlRange,
} from '../../features/ftms/control-point';
import { FtmsController } from '../../features/ftms/ftms-controller';
import { fullUuid } from '../../features/ftms/protocol';
import { FakeTransport } from '../ftms-helpers';

const S16 = fc.integer({ min: -0x8000, max: 0x7fff });

const range: fc.Arbitrary<ControlRange> = fc
  .tuple(S16, S16, fc.integer({ min: 1, max: 0xffff }))
  .map(([a, b, step]) => ({ min: Math.min(a, b), max: Math.max(a, b), step }));

function encodeRange({ min, max, step }: ControlRange): Uint8Array {
  return Uint8Array.of(
    min & 0xff,
    (min >> 8) & 0xff,
    max & 0xff,
    (max >> 8) & 0xff,
    step & 0xff,
    step >> 8,
  );
}

const onGrid = (value: number, { min, step }: ControlRange) => (value - min) % step === 0;

describe('FTMS Control Point round-trips', () => {
  it('carries any sint16 target power and resistance unchanged', () => {
    fc.assert(
      fc.property(S16, (value) => {
        const power = encodeTargetPower(value);
        expect(decodeMachineStatus(Uint8Array.of(0x08, ...power.slice(1)))).toEqual({
          kind: 'targetPower',
          watts: value,
        });
        const resistance = encodeTargetResistance(value);
        expect(decodeMachineStatus(Uint8Array.of(0x07, ...resistance.slice(1)))).toEqual({
          kind: 'targetResistance',
          tenths: value,
        });
      }),
      { numRuns: 500 },
    );
  });

  it('carries the FTMS 1.0 resistance form unchanged', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xff }), (tenths) => {
        const bytes = encodeLegacyTargetResistance(tenths);
        expect(bytes).not.toBeNull();
        expect(decodeMachineStatus(Uint8Array.of(0x07, ...(bytes ?? []).slice(1)))).toEqual({
          kind: 'targetResistance',
          tenths,
        });
      }),
    );
  });

  it('decodes every response code it can be sent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xff }), fc.integer({ min: 1, max: 5 }), (op, code) => {
        expect(decodeControlResponse(Uint8Array.of(0x80, op, code))?.requestOpCode).toBe(op);
      }),
    );
  });

  it('decodes every valid supported range back', () => {
    fc.assert(
      fc.property(range, (value) => {
        expect(decodeRange(encodeRange(value))).toEqual(value);
      }),
      { numRuns: 500 },
    );
  });
});

describe('clampToRange', () => {
  it('lands inside the range, on the increment grid', () => {
    fc.assert(
      fc.property(range, fc.double({ noNaN: false }), (bounds, value) => {
        const clamped = clampToRange(value, bounds);
        expect(Number.isInteger(clamped)).toBe(true);
        expect(clamped).toBeGreaterThanOrEqual(bounds.min);
        expect(clamped).toBeLessThanOrEqual(bounds.max);
        expect(onGrid(clamped, bounds)).toBe(true);
        expect(clampToRange(clamped, bounds)).toBe(clamped);
      }),
      { numRuns: 1_000 },
    );
  });

  it('keeps a value that is already allowed', () => {
    fc.assert(
      fc.property(
        range.chain((bounds) =>
          fc
            .integer({ min: 0, max: Math.floor((bounds.max - bounds.min) / bounds.step) })
            .map((steps) => ({ bounds, value: bounds.min + steps * bounds.step })),
        ),
        ({ bounds, value }) => {
          expect(clampToRange(value, bounds)).toBe(value);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is monotonic', () => {
    fc.assert(
      fc.property(range, fc.integer(), fc.integer(), (bounds, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(clampToRange(low, bounds)).toBeLessThanOrEqual(clampToRange(high, bounds));
      }),
      { numRuns: 500 },
    );
  });
});

describe('decoders on arbitrary bytes', () => {
  it('never throw', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 20 }), (bytes) => {
        decodeControlResponse(bytes);
        decodeMachineStatus(bytes);
        decodeRange(bytes);
        decodeTargetFeatures(bytes);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('MachineControl writes', () => {
  const CONTROL_POINT = fullUuid(0x2ad9);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function readS16(bytes: Uint8Array): number {
    const raw = (bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8);
    return raw >= 0x8000 ? raw - 0x10000 : raw;
  }

  it('never sends a target outside the advertised range', async () => {
    const command = fc.oneof(
      fc.record({
        kind: fc.constant('power' as const),
        value: fc.integer({ min: -100_000, max: 100_000 }),
      }),
      fc.record({
        kind: fc.constant('resistance' as const),
        value: fc.integer({ min: -100_000, max: 100_000 }),
      }),
      fc.record({ kind: fc.constant('stepPower' as const), up: fc.boolean() }),
      fc.record({ kind: fc.constant('stepResistance' as const), up: fc.boolean() }),
    );
    await fc.assert(
      fc.asyncProperty(
        range,
        range,
        fc.array(command, { maxLength: 15 }),
        async (power, resistance, commands) => {
          const transport = new FakeTransport();
          transport.characteristicUuids = [
            fullUuid(0x2acc),
            fullUuid(0x2ad2),
            CONTROL_POINT,
            fullUuid(0x2ad6),
            fullUuid(0x2ad8),
          ];
          transport.values.set(fullUuid(0x2acc), Uint8Array.of(0, 0, 0, 0, 0x0c, 0, 0, 0));
          transport.values.set(fullUuid(0x2ad8), encodeRange(power));
          transport.values.set(fullUuid(0x2ad6), encodeRange(resistance));
          transport.respond = (_uuid, bytes) => Uint8Array.of(0x80, bytes[0] ?? 0, 0x01);
          const controller = new FtmsController({ transport });
          await controller.connect('bike-1');
          await vi.advanceTimersByTimeAsync(0);
          const { control } = controller;
          await control.requestControl();
          for (const step of commands) {
            if (step.kind === 'power') await control.setTargetPower(step.value);
            else if (step.kind === 'resistance') await control.setTargetResistance(step.value);
            else if (step.kind === 'stepPower') await control.stepPower(step.up ? 1 : -1);
            else await control.stepResistance(step.up ? 1 : -1);
          }
          for (const { bytes } of transport.writes) {
            const bounds = bytes[0] === 0x05 ? power : bytes[0] === 0x04 ? resistance : null;
            if (bounds === null) continue;
            const value = readS16(bytes);
            expect(value).toBeGreaterThanOrEqual(bounds.min);
            expect(value).toBeLessThanOrEqual(bounds.max);
            expect(onGrid(value, bounds)).toBe(true);
          }
          controller.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });
});

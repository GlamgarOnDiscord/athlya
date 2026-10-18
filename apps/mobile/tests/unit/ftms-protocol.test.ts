import { describe, expect, it } from 'vitest';

import {
  decodeMachineData,
  fullUuid,
  machineTypeOf,
  normaliseUuid,
  pickMachineCharacteristic,
} from '../../features/ftms/protocol';
import { hex } from '../ftms-helpers';

describe('FTMS UUIDs', () => {
  it('expands assigned numbers to the Bluetooth base UUID', () => {
    expect(fullUuid(0x1826)).toBe('00001826-0000-1000-8000-00805f9b34fb');
    expect(normaliseUuid('2AD2')).toBe('00002ad2-0000-1000-8000-00805f9b34fb');
    expect(normaliseUuid('00002AD2-0000-1000-8000-00805F9B34FB')).toBe(fullUuid(0x2ad2));
  });

  it('maps data characteristics to machine types', () => {
    expect(machineTypeOf(fullUuid(0x2ad2))).toBe('indoorBike');
    expect(machineTypeOf('2acd')).toBe('treadmill');
    expect(machineTypeOf(fullUuid(0x2ad1))).toBe('rower');
    expect(machineTypeOf(fullUuid(0x2ace))).toBe('crossTrainer');
    expect(machineTypeOf(fullUuid(0x2acc))).toBeNull();
  });

  it('picks the highest-priority data characteristic', () => {
    expect(
      pickMachineCharacteristic([fullUuid(0x2acc), fullUuid(0x2ace), fullUuid(0x2ad2)]),
    ).toEqual({ machine: 'indoorBike', uuid: fullUuid(0x2ad2) });
    expect(pickMachineCharacteristic([fullUuid(0x2ad9), fullUuid(0x2acc)])).toBeNull();
  });
});

describe('Indoor Bike Data (0x2AD2)', () => {
  it('decodes speed, cadence, power and heart rate', () => {
    // Flags 0x0244: speed (bit 0 clear), cadence (2), power (6), heart rate (9).
    expect(decodeMachineData('indoorBike', hex('4402 f609 b400 c800 8c'))).toEqual({
      speedKmh: 25.5,
      cadenceRpm: 90,
      powerW: 200,
      heartRateBpm: 140,
    });
  });

  it('reads power as signed', () => {
    expect(decodeMachineData('indoorBike', hex('4100 f6ff'))).toEqual({ powerW: -10 });
  });

  it('accepts a uint8 resistance level (GATT Supplement layout)', () => {
    // Flags 0x0061: no speed, resistance (5), power (6).
    expect(decodeMachineData('indoorBike', hex('6100 0a 9600'))).toEqual({
      resistanceLevel: 10,
      powerW: 150,
    });
  });

  it('accepts a sint16 resistance level (FTMS 1.0 layout)', () => {
    expect(decodeMachineData('indoorBike', hex('6100 0a00 9600'))).toEqual({
      resistanceLevel: 10,
      powerW: 150,
    });
  });

  it('reads distance, energy and elapsed time, skipping averages', () => {
    // Flags 0x091b: no speed, average speed (1), average cadence (3),
    // distance (4), energy (8), elapsed (11).
    expect(decodeMachineData('indoorBike', hex('1b09 e803 a000 102700 3200 5802 0a 2c01'))).toEqual(
      { distanceM: 10_000, energyKcal: 50, elapsedSec: 300 },
    );
  });

  it('drops "data not available" energy and a 0 bpm heart rate', () => {
    // Flags 0x0301: no speed, energy (8), heart rate (9).
    expect(decodeMachineData('indoorBike', hex('0103 ffff ffff ff 00'))).toEqual({});
  });

  it('rejects packets shorter than their flags announce', () => {
    expect(decodeMachineData('indoorBike', hex('4402 f609'))).toBeNull();
    expect(decodeMachineData('indoorBike', hex('44'))).toBeNull();
    expect(decodeMachineData('indoorBike', new Uint8Array())).toBeNull();
  });

  it('keeps the announced fields of a packet with trailing padding', () => {
    expect(decodeMachineData('indoorBike', hex('4000 f609 0000 0000'))).toEqual({
      speedKmh: 25.5,
      powerW: 0,
    });
  });
});

describe('Treadmill Data (0x2ACD)', () => {
  it('decodes speed, distance, incline, energy and elapsed time', () => {
    // Flags 0x048c: speed, distance (2), incline + ramp (3), energy (7), elapsed (10).
    expect(
      decodeMachineData('treadmill', hex('8c04 e803 d20400 1900 0000 3200 5802 0a 2c01')),
    ).toEqual({
      speedKmh: 10,
      distanceM: 1234,
      inclinePct: 2.5,
      energyKcal: 50,
      elapsedSec: 300,
    });
  });

  it('reads power from the force-on-belt field pair', () => {
    // Flags 0x1001: no speed, force on belt + power (12).
    expect(decodeMachineData('treadmill', hex('0110 1400 fa00'))).toEqual({ powerW: 250 });
  });

  it('accepts uint8 pace (FTMS 1.0) and uint16 pace (GATT Supplement)', () => {
    // Flags 0x0121: no speed, instantaneous pace (5), heart rate (8).
    expect(decodeMachineData('treadmill', hex('2101 32 8c'))).toEqual({ heartRateBpm: 140 });
    expect(decodeMachineData('treadmill', hex('2101 9600 8c'))).toEqual({ heartRateBpm: 140 });
  });
});

describe('Rower Data (0x2AD1)', () => {
  it('decodes stroke rate and count (present when bit 0 is clear), power and elapsed time', () => {
    // Flags 0x0820: stroke rate + count, power (5), elapsed (11).
    expect(decodeMachineData('rower', hex('2008 38 7800 b400 5802'))).toEqual({
      strokeRatePerMin: 28,
      strokeCount: 120,
      powerW: 180,
      elapsedSec: 600,
    });
  });

  it('skips pace fields', () => {
    // Flags 0x001d: no stroke data, distance (2), pace (3), average pace (4).
    expect(decodeMachineData('rower', hex('1d00 f40100 7800 7d00'))).toEqual({ distanceM: 500 });
  });
});

describe('Cross Trainer Data (0x2ACE)', () => {
  it('reads 24-bit flags', () => {
    // Flags 0x002108: speed, step rate + average (3), power (8), elapsed (13).
    expect(decodeMachineData('crossTrainer', hex('082100 2003 7800 6e00 5a00 3d00'))).toEqual({
      speedKmh: 8,
      stepRatePerMin: 120,
      powerW: 90,
      elapsedSec: 61,
    });
  });

  it('ignores the movement direction flag, which carries no field', () => {
    // Flags 0x008001: no speed, movement direction (15).
    expect(decodeMachineData('crossTrainer', hex('018000'))).toEqual({});
  });
});

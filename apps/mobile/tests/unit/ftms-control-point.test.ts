import { describe, expect, it } from 'vitest';

import {
  clampToRange,
  decodeControlResponse,
  decodeMachineStatus,
  decodeRange,
  decodeTargetFeatures,
  encodeLegacyTargetResistance,
  encodeRequestControl,
  encodeReset,
  encodeStartOrResume,
  encodeStopOrPause,
  encodeTargetPower,
  encodeTargetResistance,
} from '../../features/ftms/control-point';
import { stepSize } from '../../features/ftms/machine-control';
import { base64ToBytes, bytesToBase64 } from '../../infrastructure/ble/base64';
import { hex } from '../ftms-helpers';

describe('FTMS Control Point requests', () => {
  it.each([
    ['Request Control', encodeRequestControl(), '00'],
    ['Reset', encodeReset(), '01'],
    ['Set Target Resistance Level 8.5', encodeTargetResistance(85), '04 5500'],
    ['Set Target Resistance Level -1.0', encodeTargetResistance(-10), '04 f6ff'],
    ['Set Target Power 250 W', encodeTargetPower(250), '05 fa00'],
    ['Set Target Power 1500 W', encodeTargetPower(1500), '05 dc05'],
    ['Start or Resume', encodeStartOrResume(), '07'],
    ['Stop', encodeStopOrPause('stop'), '08 01'],
    ['Pause', encodeStopOrPause('pause'), '08 02'],
  ])('encodes %s', (_name, bytes, expected) => {
    expect(bytes).toEqual(hex(expected));
  });

  it('encodes the FTMS 1.0 resistance form only when it fits a uint8', () => {
    expect(encodeLegacyTargetResistance(85)).toEqual(hex('04 55'));
    expect(encodeLegacyTargetResistance(255)).toEqual(hex('04 ff'));
    expect(encodeLegacyTargetResistance(256)).toBeNull();
    expect(encodeLegacyTargetResistance(-1)).toBeNull();
  });

  it('refuses parameters a sint16 cannot carry', () => {
    expect(() => encodeTargetPower(0x8000)).toThrow(RangeError);
    expect(() => encodeTargetPower(12.5)).toThrow(RangeError);
    expect(() => encodeTargetResistance(-0x8001)).toThrow(RangeError);
  });
});

describe('FTMS Control Point responses', () => {
  it.each([
    ['80 00 01', 0x00, 'success'],
    ['80 05 02', 0x05, 'notSupported'],
    ['80 04 03', 0x04, 'invalidParameter'],
    ['80 07 04', 0x07, 'failed'],
    ['80 00 05', 0x00, 'notPermitted'],
  ] as const)('decodes %s', (bytes, requestOpCode, result) => {
    expect(decodeControlResponse(hex(bytes))).toEqual({ requestOpCode, result });
  });

  it.each(['', '80 00', '05 00 01', '80 00 00', '80 00 06'])('ignores %j', (bytes) => {
    expect(decodeControlResponse(hex(bytes))).toBeNull();
  });
});

describe('FTMS feature and range characteristics', () => {
  it('reads the target setting features', () => {
    expect(decodeTargetFeatures(hex('02400000 0c000000'))).toEqual({
      resistance: true,
      power: true,
    });
    expect(decodeTargetFeatures(hex('86500000 04000000'))).toEqual({
      resistance: true,
      power: false,
    });
    // Machine feature bits (resistance level, power measurement) are not targets.
    expect(decodeTargetFeatures(hex('80400000 00000000'))).toEqual({
      resistance: false,
      power: false,
    });
    expect(decodeTargetFeatures(hex('02400000 0c0000'))).toBeNull();
  });

  it('reads supported ranges', () => {
    expect(decodeRange(hex('0000 e803 0100'))).toEqual({ min: 0, max: 1000, step: 1 });
    expect(decodeRange(hex('0a00 c800 0a00'))).toEqual({ min: 10, max: 200, step: 10 });
    expect(decodeRange(hex('f6ff 6400 0500'))).toEqual({ min: -10, max: 100, step: 5 });
  });

  it.each([
    ['a zero increment', '0000 e803 0000'],
    ['an empty range', 'e803 0000 0100'],
    ['a short packet', '0000 e803 01'],
  ])('rejects %s', (_name, bytes) => {
    expect(decodeRange(hex(bytes))).toBeNull();
  });
});

describe('clampToRange', () => {
  const range = { min: 10, max: 200, step: 10 };

  it.each([
    [5, 10],
    [10, 10],
    [14, 10],
    [15, 20],
    [196, 200],
    [250, 200],
    [Number.POSITIVE_INFINITY, 200],
    [Number.NEGATIVE_INFINITY, 10],
    [Number.NaN, 10],
  ])('fits %d to %d', (value, expected) => {
    expect(clampToRange(value, range)).toBe(expected);
  });

  it('stays on the increment grid when the maximum is not', () => {
    expect(clampToRange(1003, { min: 0, max: 1005, step: 10 })).toBe(1000);
    expect(clampToRange(1004.9, { min: 0, max: 1005, step: 10 })).toBe(1000);
  });

  it('rounds stepper increments up to the machine increment', () => {
    expect(stepSize({ min: 0, max: 1000, step: 1 }, 5)).toBe(5);
    expect(stepSize({ min: 0, max: 1000, step: 2 }, 5)).toBe(6);
    expect(stepSize({ min: 0, max: 1000, step: 25 }, 5)).toBe(25);
  });
});

describe('Fitness Machine Status', () => {
  it.each([
    ['01', { kind: 'reset' }],
    ['02 01', { kind: 'stopped' }],
    ['02 02', { kind: 'paused' }],
    ['03 01', { kind: 'stopped' }],
    ['04', { kind: 'started' }],
    ['07 55', { kind: 'targetResistance', tenths: 85 }],
    ['07 2c01', { kind: 'targetResistance', tenths: 300 }],
    ['08 c800', { kind: 'targetPower', watts: 200 }],
    ['08 ffff', { kind: 'targetPower', watts: -1 }],
    ['ff', { kind: 'controlLost' }],
  ])('decodes %s', (bytes, event) => {
    expect(decodeMachineStatus(hex(bytes))).toEqual(event);
  });

  it.each(['', '07', '08 c8', '05 e803', '0a'])('ignores %j', (bytes) => {
    expect(decodeMachineStatus(hex(bytes))).toBeNull();
  });
});

describe('base64 for characteristic writes', () => {
  it.each([
    ['', ''],
    ['00', 'AA=='],
    ['05 fa00', 'BfoA'],
    ['05 fa', 'Bfo='],
    ['04 5500', 'BFUA'],
    ['80 00 01 ff', 'gAAB/w=='],
  ])('encodes %j as %j', (bytes, base64) => {
    expect(bytesToBase64(hex(bytes))).toBe(base64);
    expect(base64ToBytes(base64)).toEqual(hex(bytes));
  });
});

/**
 * FTMS Fitness Machine Control Point (0x2AD9) and the characteristics that
 * describe what it accepts — issue #668.
 *
 * Every request is one op code byte followed by its little-endian
 * parameter. The machine answers each write with a Response Code
 * indication (`0x80`, request op code, result code). Targets are carried
 * as raw integers in protocol units (resistance in 0.1 steps, power in
 * watts); {@link clampToRange} is the single place a raw target is fitted
 * to the range the machine advertises, so nothing outside it is ever
 * encoded.
 *
 * Two published layouts disagree on the Set Target Resistance Level
 * parameter: the FTMS 1.0 specification sends a uint8, the GATT
 * Specification Supplement a sint16 (both in 0.1 steps). The supplement
 * form is sent first; {@link encodeLegacyTargetResistance} is the retry
 * for machines that reject it.
 */

export const CONTROL_POINT_CHARACTERISTIC = 0x2ad9;
export const FEATURE_CHARACTERISTIC = 0x2acc;
export const RESISTANCE_RANGE_CHARACTERISTIC = 0x2ad6;
export const POWER_RANGE_CHARACTERISTIC = 0x2ad8;
export const STATUS_CHARACTERISTIC = 0x2ada;

export const OpCode = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetResistance: 0x04,
  setTargetPower: 0x05,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  response: 0x80,
} as const;

export type RequestOpCode = Exclude<(typeof OpCode)[keyof typeof OpCode], 0x80>;

export type ResultCode =
  'success' | 'notSupported' | 'invalidParameter' | 'failed' | 'notPermitted';

const RESULT_CODES: Readonly<Record<number, ResultCode>> = {
  0x01: 'success',
  0x02: 'notSupported',
  0x03: 'invalidParameter',
  0x04: 'failed',
  0x05: 'notPermitted',
};

/** Stop or Pause parameter values. */
export type StopKind = 'stop' | 'pause';
const STOP_KIND: Readonly<Record<StopKind, number>> = { stop: 0x01, pause: 0x02 };

const S16_MIN = -0x8000;
const S16_MAX = 0x7fff;

function s16(value: number): number[] {
  if (!Number.isInteger(value) || value < S16_MIN || value > S16_MAX) {
    throw new RangeError(`sint16 out of range: ${String(value)}`);
  }
  return [value & 0xff, (value >> 8) & 0xff];
}

function readS16(bytes: Uint8Array, offset: number): number {
  const raw = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (readU16(bytes, offset) | (readU16(bytes, offset + 2) << 16)) >>> 0;
}

export function encodeRequestControl(): Uint8Array {
  return Uint8Array.of(OpCode.requestControl);
}

export function encodeReset(): Uint8Array {
  return Uint8Array.of(OpCode.reset);
}

/** Target resistance level in 0.1 steps (sint16, GATT Specification Supplement). */
export function encodeTargetResistance(tenths: number): Uint8Array {
  return Uint8Array.of(OpCode.setTargetResistance, ...s16(tenths));
}

/** FTMS 1.0 form (uint8 in 0.1 steps); null when the level does not fit. */
export function encodeLegacyTargetResistance(tenths: number): Uint8Array | null {
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > 0xff) return null;
  return Uint8Array.of(OpCode.setTargetResistance, tenths);
}

/** Target power in watts (sint16). */
export function encodeTargetPower(watts: number): Uint8Array {
  return Uint8Array.of(OpCode.setTargetPower, ...s16(watts));
}

export function encodeStartOrResume(): Uint8Array {
  return Uint8Array.of(OpCode.startOrResume);
}

export function encodeStopOrPause(kind: StopKind): Uint8Array {
  return Uint8Array.of(OpCode.stopOrPause, STOP_KIND[kind]);
}

export interface ControlResponse {
  readonly requestOpCode: number;
  readonly result: ResultCode;
}

/** Decodes a Response Code indication; null for anything else. */
export function decodeControlResponse(bytes: Uint8Array): ControlResponse | null {
  if (bytes.length < 3 || bytes[0] !== OpCode.response) return null;
  const result = RESULT_CODES[bytes[2] ?? 0];
  if (result === undefined) return null;
  return { requestOpCode: bytes[1] ?? 0, result };
}

/** Target Setting Features bits the app drives. */
const TARGET_RESISTANCE_BIT = 1 << 2;
const TARGET_POWER_BIT = 1 << 3;

export interface TargetFeatures {
  readonly resistance: boolean;
  readonly power: boolean;
}

/**
 * Reads the Target Setting Features half of Fitness Machine Feature
 * (uint32 machine features, then uint32 target setting features).
 */
export function decodeTargetFeatures(bytes: Uint8Array): TargetFeatures | null {
  if (bytes.length < 8) return null;
  const targets = readU32(bytes, 4);
  return {
    resistance: (targets & TARGET_RESISTANCE_BIT) !== 0,
    power: (targets & TARGET_POWER_BIT) !== 0,
  };
}

/** A supported target range in raw protocol units. */
export interface ControlRange {
  readonly min: number;
  readonly max: number;
  /** Minimum increment, always > 0. */
  readonly step: number;
}

/**
 * Decodes Supported Resistance Level Range / Supported Power Range:
 * sint16 minimum, sint16 maximum, uint16 minimum increment. A range that
 * cannot be honoured (empty, or a zero increment) yields null, which
 * hides the control.
 */
export function decodeRange(bytes: Uint8Array): ControlRange | null {
  if (bytes.length < 6) return null;
  const min = readS16(bytes, 0);
  const max = readS16(bytes, 2);
  const step = readU16(bytes, 4);
  if (min > max || step === 0) return null;
  return { min, max, step };
}

/**
 * Fits a raw target to `range`: the nearest value on the increment grid
 * that starts at `min`, never below `min` nor above `max`.
 */
export function clampToRange(value: number, range: ControlRange): number {
  const { min, max, step } = range;
  if (Number.isNaN(value) || value <= min) return min;
  const top = min + Math.floor((max - min) / step) * step;
  if (value >= top) return top;
  return min + Math.round((value - min) / step) * step;
}

export type MachineStatusEvent =
  | { readonly kind: 'reset' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'started' }
  | { readonly kind: 'targetResistance'; readonly tenths: number }
  | { readonly kind: 'targetPower'; readonly watts: number }
  | { readonly kind: 'controlLost' };

/**
 * Decodes the Fitness Machine Status events the app reacts to; null for
 * the others and for malformed packets. Target Resistance Level Changed
 * is a uint8 in FTMS 1.0 and a sint16 in the GATT Specification
 * Supplement, so its width follows the packet length.
 */
export function decodeMachineStatus(bytes: Uint8Array): MachineStatusEvent | null {
  switch (bytes[0]) {
    case 0x01:
      return { kind: 'reset' };
    case 0x02:
      if (bytes[1] === 0x02) return { kind: 'paused' };
      return { kind: 'stopped' };
    case 0x03:
      return { kind: 'stopped' };
    case 0x04:
      return { kind: 'started' };
    case 0x07:
      if (bytes.length === 2) return { kind: 'targetResistance', tenths: bytes[1] ?? 0 };
      if (bytes.length >= 3) return { kind: 'targetResistance', tenths: readS16(bytes, 1) };
      return null;
    case 0x08:
      if (bytes.length < 3) return null;
      return { kind: 'targetPower', watts: readS16(bytes, 1) };
    case 0xff:
      return { kind: 'controlLost' };
    default:
      return null;
  }
}

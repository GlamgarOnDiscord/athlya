/**
 * Bluetooth Heart Rate Service (0x180D) decoding — issue #669.
 *
 * Chest straps and watches notify Heart Rate Measurement (0x2A37): a
 * flags byte, the heart rate (uint8 or uint16), then the optional Energy
 * Expended (uint16, kJ) and as many RR-intervals (uint16, 1/1024 s) as
 * the packet holds. Bits 1-2 report skin contact: bit 2 says the sensor
 * can detect it, bit 1 whether it currently does.
 */
import { fullUuid, normaliseUuid } from './protocol';

export const HEART_RATE_SERVICE = 0x180d;
export const HEART_RATE_MEASUREMENT = 0x2a37;

const FLAG_UINT16 = 0x01;
const FLAG_CONTACT_DETECTED = 0x02;
const FLAG_CONTACT_SUPPORTED = 0x04;
const FLAG_ENERGY = 0x08;
const FLAG_RR = 0x10;

/** RR-interval resolution: 1/1024 s, so 1000/1024 ms per unit (exact in binary). */
const RR_UNIT_MS = 1000 / 1024;

export type SensorContact = 'detected' | 'notDetected' | 'unsupported';

export interface HeartRateMeasurement {
  readonly bpm: number;
  readonly contact: SensorContact;
  /** Cumulative energy since the sensor was reset, in kJ; null when not sent. */
  readonly energyExpendedKj: number | null;
  /** RR-intervals in ms, oldest first. */
  readonly rrIntervalsMs: readonly number[];
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function contactOf(flags: number): SensorContact {
  if ((flags & FLAG_CONTACT_SUPPORTED) === 0) return 'unsupported';
  return (flags & FLAG_CONTACT_DETECTED) === 0 ? 'notDetected' : 'detected';
}

/**
 * Decodes one Heart Rate Measurement notification. Returns null for a
 * packet shorter than its flags announce; never throws, since it runs
 * inside the BLE notification callback. An odd trailing byte after the
 * RR-intervals, or bytes the flags do not announce, are ignored.
 */
export function decodeHeartRateMeasurement(bytes: Uint8Array): HeartRateMeasurement | null {
  const flags = bytes[0];
  if (flags === undefined) return null;
  let offset = 1;
  const wide = (flags & FLAG_UINT16) !== 0;
  if (bytes.length < offset + (wide ? 2 : 1)) return null;
  const bpm = wide ? readU16(bytes, offset) : (bytes[offset] ?? 0);
  offset += wide ? 2 : 1;

  let energyExpendedKj: number | null = null;
  if ((flags & FLAG_ENERGY) !== 0) {
    if (bytes.length < offset + 2) return null;
    energyExpendedKj = readU16(bytes, offset);
    offset += 2;
  }

  const rrIntervalsMs: number[] = [];
  if ((flags & FLAG_RR) !== 0) {
    for (; offset + 2 <= bytes.length; offset += 2) {
      rrIntervalsMs.push(readU16(bytes, offset) * RR_UNIT_MS);
    }
  }
  return { bpm, contact: contactOf(flags), energyExpendedKj, rrIntervalsMs };
}

/**
 * The heart rate worth showing and recording, or null when the strap
 * reports no skin contact or a zero value (strap not worn).
 */
export function usableHeartRate(measurement: HeartRateMeasurement): number | null {
  if (measurement.contact === 'notDetected' || measurement.bpm === 0) return null;
  return measurement.bpm;
}

/** The Heart Rate Measurement characteristic among the discovered ones, as reported. */
export function pickHeartRateCharacteristic(characteristicUuids: readonly string[]): string | null {
  const wanted = fullUuid(HEART_RATE_MEASUREMENT);
  return characteristicUuids.find((uuid) => normaliseUuid(uuid) === wanted) ?? null;
}

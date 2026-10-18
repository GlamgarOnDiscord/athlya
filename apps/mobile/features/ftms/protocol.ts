/**
 * Bluetooth Fitness Machine Service (FTMS, 0x1826) data decoding — task 23.1.
 *
 * Each machine type notifies one data characteristic: a little-endian
 * flags field followed by the optional fields the flags announce, in a
 * fixed order. Bit 0 ("More Data") is inverted: the first field is present
 * when the bit is clear. A record may be split over several notifications,
 * so every decoded sample is partial and the live session merges them.
 *
 * Two published layouts disagree on a few widths: the FTMS 1.0
 * specification encodes Resistance Level as sint16 and Treadmill pace as
 * uint8, the GATT Specification Supplement as uint8 and uint16. Machines
 * in the field ship both, so the decoder tries each layout and keeps the
 * one whose length matches the packet.
 */

export type MachineType = 'indoorBike' | 'treadmill' | 'rower' | 'crossTrainer';

/** Short (16-bit) UUIDs from the Bluetooth assigned numbers. */
export const FTMS_SERVICE = 0x1826;
export const MACHINE_DATA_CHARACTERISTICS: Readonly<Record<MachineType, number>> = {
  indoorBike: 0x2ad2,
  treadmill: 0x2acd,
  rower: 0x2ad1,
  crossTrainer: 0x2ace,
};

/** Preferred order when a machine exposes several data characteristics. */
export const MACHINE_PRIORITY: readonly MachineType[] = [
  'indoorBike',
  'treadmill',
  'rower',
  'crossTrainer',
];

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Expands a 16-bit assigned number to the 128-bit form BLE stacks report. */
export function fullUuid(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}${BASE_UUID_SUFFIX}`;
}

/** Normalises a 16- or 128-bit UUID string to the lowercase 128-bit form. */
export function normaliseUuid(uuid: string): string {
  const value = uuid.trim().toLowerCase();
  if (/^[0-9a-f]{4}$/u.test(value)) return fullUuid(Number.parseInt(value, 16));
  return value;
}

/** Machine type served by a data characteristic, or null for any other UUID. */
export function machineTypeOf(characteristicUuid: string): MachineType | null {
  const uuid = normaliseUuid(characteristicUuid);
  for (const machine of MACHINE_PRIORITY) {
    if (fullUuid(MACHINE_DATA_CHARACTERISTICS[machine]) === uuid) return machine;
  }
  return null;
}

/** Highest-priority machine data characteristic among the discovered ones. */
export function pickMachineCharacteristic(
  characteristicUuids: readonly string[],
): { readonly machine: MachineType; readonly uuid: string } | null {
  const found = new Map<MachineType, string>();
  for (const uuid of characteristicUuids) {
    const machine = machineTypeOf(uuid);
    if (machine !== null && !found.has(machine)) found.set(machine, uuid);
  }
  for (const machine of MACHINE_PRIORITY) {
    const uuid = found.get(machine);
    if (uuid !== undefined) return { machine, uuid };
  }
  return null;
}

/** Metrics a notification may carry, already scaled to their units. */
export interface FtmsSample {
  readonly speedKmh?: number;
  readonly cadenceRpm?: number;
  readonly distanceM?: number;
  readonly resistanceLevel?: number;
  readonly powerW?: number;
  readonly energyKcal?: number;
  readonly heartRateBpm?: number;
  readonly elapsedSec?: number;
  readonly strokeRatePerMin?: number;
  readonly strokeCount?: number;
  readonly stepRatePerMin?: number;
  readonly inclinePct?: number;
}

export type MetricKey = keyof FtmsSample;

export type FieldType = 'u8' | 'u16' | 's16' | 'u24';

const SIZES: Readonly<Record<FieldType, number>> = { u8: 1, u16: 2, s16: 2, u24: 3 };

export interface FieldPart {
  readonly type: FieldType;
  /** Width in the FTMS 1.0 layout when it differs from the GATT Supplement. */
  readonly legacyType?: FieldType;
  /** Metric the value maps to; parts without one are read and skipped. */
  readonly metric?: MetricKey;
  readonly scale?: number;
  /** Raw value meaning "data not available". */
  readonly unavailable?: number;
}

export interface FieldSpec {
  readonly bit: number;
  /** Present when the bit is clear (bit 0, "More Data"). */
  readonly inverted?: boolean;
  readonly parts: readonly FieldPart[];
}

export interface MachineLayout {
  readonly flagsBytes: 2 | 3;
  readonly fields: readonly FieldSpec[];
}

const SPEED: FieldPart = { type: 'u16', metric: 'speedKmh', scale: 0.01 };
const SKIP_U16: FieldPart = { type: 'u16' };
const SKIP_S16: FieldPart = { type: 's16' };
const SKIP_U8: FieldPart = { type: 'u8' };
const DISTANCE: FieldPart = { type: 'u24', metric: 'distanceM' };
const RESISTANCE: FieldPart = { type: 'u8', legacyType: 's16', metric: 'resistanceLevel' };
const POWER: FieldPart = { type: 's16', metric: 'powerW' };
const ENERGY: readonly FieldPart[] = [
  { type: 'u16', metric: 'energyKcal', unavailable: 0xffff },
  SKIP_U16,
  SKIP_U8,
];
/** 0 bpm is what machines send while nobody touches the grips. */
const HEART_RATE: FieldPart = { type: 'u8', metric: 'heartRateBpm', unavailable: 0 };
const ELAPSED: FieldPart = { type: 'u16', metric: 'elapsedSec' };

export const MACHINE_LAYOUTS: Readonly<Record<MachineType, MachineLayout>> = {
  indoorBike: {
    flagsBytes: 2,
    fields: [
      { bit: 0, inverted: true, parts: [SPEED] },
      { bit: 1, parts: [SKIP_U16] },
      { bit: 2, parts: [{ type: 'u16', metric: 'cadenceRpm', scale: 0.5 }] },
      { bit: 3, parts: [SKIP_U16] },
      { bit: 4, parts: [DISTANCE] },
      { bit: 5, parts: [RESISTANCE] },
      { bit: 6, parts: [POWER] },
      { bit: 7, parts: [SKIP_S16] },
      { bit: 8, parts: ENERGY },
      { bit: 9, parts: [HEART_RATE] },
      { bit: 10, parts: [SKIP_U8] },
      { bit: 11, parts: [ELAPSED] },
      { bit: 12, parts: [SKIP_U16] },
    ],
  },
  treadmill: {
    flagsBytes: 2,
    fields: [
      { bit: 0, inverted: true, parts: [SPEED] },
      { bit: 1, parts: [SKIP_U16] },
      { bit: 2, parts: [DISTANCE] },
      { bit: 3, parts: [{ type: 's16', metric: 'inclinePct', scale: 0.1 }, SKIP_S16] },
      { bit: 4, parts: [SKIP_U16, SKIP_U16] },
      { bit: 5, parts: [{ type: 'u16', legacyType: 'u8' }] },
      { bit: 6, parts: [{ type: 'u16', legacyType: 'u8' }] },
      { bit: 7, parts: ENERGY },
      { bit: 8, parts: [HEART_RATE] },
      { bit: 9, parts: [SKIP_U8] },
      { bit: 10, parts: [ELAPSED] },
      { bit: 11, parts: [SKIP_U16] },
      { bit: 12, parts: [SKIP_S16, POWER] },
    ],
  },
  rower: {
    flagsBytes: 2,
    fields: [
      {
        bit: 0,
        inverted: true,
        parts: [
          { type: 'u8', metric: 'strokeRatePerMin', scale: 0.5 },
          { type: 'u16', metric: 'strokeCount' },
        ],
      },
      { bit: 1, parts: [SKIP_U8] },
      { bit: 2, parts: [DISTANCE] },
      { bit: 3, parts: [SKIP_U16] },
      { bit: 4, parts: [SKIP_U16] },
      { bit: 5, parts: [POWER] },
      { bit: 6, parts: [SKIP_S16] },
      { bit: 7, parts: [RESISTANCE] },
      { bit: 8, parts: ENERGY },
      { bit: 9, parts: [HEART_RATE] },
      { bit: 10, parts: [SKIP_U8] },
      { bit: 11, parts: [ELAPSED] },
      { bit: 12, parts: [SKIP_U16] },
    ],
  },
  crossTrainer: {
    flagsBytes: 3,
    fields: [
      { bit: 0, inverted: true, parts: [SPEED] },
      { bit: 1, parts: [SKIP_U16] },
      { bit: 2, parts: [DISTANCE] },
      { bit: 3, parts: [{ type: 'u16', metric: 'stepRatePerMin' }, SKIP_U16] },
      { bit: 4, parts: [SKIP_U16] },
      { bit: 5, parts: [SKIP_U16, SKIP_U16] },
      { bit: 6, parts: [{ type: 's16', metric: 'inclinePct', scale: 0.1 }, SKIP_S16] },
      { bit: 7, parts: [RESISTANCE] },
      { bit: 8, parts: [POWER] },
      { bit: 9, parts: [SKIP_S16] },
      { bit: 10, parts: ENERGY },
      { bit: 11, parts: [HEART_RATE] },
      { bit: 12, parts: [SKIP_U8] },
      { bit: 13, parts: [ELAPSED] },
      { bit: 14, parts: [SKIP_U16] },
    ],
  },
};

export type Layout = 'supplement' | 'legacy';

export function partType(part: FieldPart, layout: Layout): FieldType {
  return layout === 'legacy' ? (part.legacyType ?? part.type) : part.type;
}

export function isFieldPresent(field: FieldSpec, flags: number): boolean {
  const set = (flags & (1 << field.bit)) !== 0;
  return field.inverted === true ? !set : set;
}

function readFlags(bytes: Uint8Array, count: 2 | 3): number {
  let flags = 0;
  for (let i = 0; i < count; i += 1) flags |= (bytes[i] ?? 0) << (8 * i);
  return flags;
}

function readValue(bytes: Uint8Array, offset: number, type: FieldType): number {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  switch (type) {
    case 'u8':
      return b0;
    case 'u16':
      return b0 | (b1 << 8);
    case 's16': {
      const raw = b0 | (b1 << 8);
      return raw >= 0x8000 ? raw - 0x10000 : raw;
    }
    case 'u24':
      return b0 | (b1 << 8) | ((bytes[offset + 2] ?? 0) << 16);
  }
}

/** Removes binary floating-point noise from scaled values (0.01 × 2550). */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function decodeWith(
  layout: MachineLayout,
  bytes: Uint8Array,
  variant: Layout,
): { readonly sample: FtmsSample; readonly consumed: number } | null {
  if (bytes.length < layout.flagsBytes) return null;
  const flags = readFlags(bytes, layout.flagsBytes);
  const sample: Partial<Record<MetricKey, number>> = {};
  let offset = layout.flagsBytes;
  for (const field of layout.fields) {
    if (!isFieldPresent(field, flags)) continue;
    for (const part of field.parts) {
      const type = partType(part, variant);
      if (offset + SIZES[type] > bytes.length) return null;
      const raw = readValue(bytes, offset, type);
      offset += SIZES[type];
      if (part.metric === undefined || raw === part.unavailable) continue;
      sample[part.metric] = round(raw * (part.scale ?? 1));
    }
  }
  return { sample, consumed: offset };
}

/**
 * Decodes one machine data notification. Returns null for a packet that
 * is shorter than its flags announce; never throws, since it runs inside
 * the BLE notification callback.
 */
export function decodeMachineData(machine: MachineType, bytes: Uint8Array): FtmsSample | null {
  const layout = MACHINE_LAYOUTS[machine];
  const supplement = decodeWith(layout, bytes, 'supplement');
  if (supplement?.consumed === bytes.length) return supplement.sample;
  const legacy = decodeWith(layout, bytes, 'legacy');
  if (legacy?.consumed === bytes.length) return legacy.sample;
  // Trailing bytes the flags do not announce (vendor padding): keep the
  // supplement reading of the announced fields.
  return supplement?.sample ?? legacy?.sample ?? null;
}

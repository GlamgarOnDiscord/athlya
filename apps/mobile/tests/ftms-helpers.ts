import { vi } from 'vitest';

import {
  isFieldPresent,
  MACHINE_LAYOUTS,
  partType,
  type FieldType,
  type Layout,
  type MachineType,
} from '../features/ftms/protocol';

import type {
  BleConnection,
  BleReadiness,
  BleTransport,
  ScannedDevice,
} from '../infrastructure/ble/ports';

/** Little-endian bytes of `value` for an FTMS field type. */
export function encodeValue(type: FieldType, value: number): number[] {
  switch (type) {
    case 'u8':
      return [value & 0xff];
    case 'u16':
    case 's16':
      return [value & 0xff, (value >> 8) & 0xff];
    case 'u24':
      return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
  }
}

/**
 * Encodes a machine data packet: `flags`, then `raw[i]` for the i-th part
 * of every present field, in specification order.
 */
export function encodeMachineData(
  machine: MachineType,
  flags: number,
  raw: readonly number[],
  layout: Layout = 'supplement',
): Uint8Array {
  const spec = MACHINE_LAYOUTS[machine];
  const bytes: number[] = [];
  for (let i = 0; i < spec.flagsBytes; i += 1) bytes.push((flags >> (8 * i)) & 0xff);
  let index = 0;
  for (const field of spec.fields) {
    if (!isFieldPresent(field, flags)) continue;
    for (const part of field.parts) {
      bytes.push(...encodeValue(partType(part, layout), raw[index] ?? 0));
      index += 1;
    }
  }
  return Uint8Array.from(bytes);
}

export function hex(value: string): Uint8Array {
  const clean = value.replace(/\s+/gu, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
  return Uint8Array.from(bytes);
}

/** In-memory BLE transport the tests drive by hand. */
export class FakeTransport implements BleTransport {
  public readiness: BleReadiness = 'ready';
  public characteristicUuids: readonly string[] = [];
  public connectError: Error | null = null;
  public scanning = false;
  public disconnects = 0;
  public monitored: string | null = null;
  #onDevice: ((device: ScannedDevice) => void) | null = null;
  #onScanError: ((error: unknown) => void) | null = null;
  #onValue: ((bytes: Uint8Array) => void) | null = null;
  #onMonitorError: ((error: unknown) => void) | null = null;
  #onDisconnected: (() => void) | null = null;
  #pendingConnect: ((connection: BleConnection) => void) | null = null;
  public holdConnect = false;

  public readonly prepare = vi.fn(() => Promise.resolve(this.readiness));

  public readonly startScan = vi.fn(
    (
      _uuids: readonly string[],
      onDevice: (device: ScannedDevice) => void,
      onError: (error: unknown) => void,
    ) => {
      this.scanning = true;
      this.#onDevice = onDevice;
      this.#onScanError = onError;
      return () => {
        this.scanning = false;
        this.#onDevice = null;
      };
    },
  );

  public readonly connect = vi.fn((deviceId: string): Promise<BleConnection> => {
    if (this.connectError !== null) return Promise.reject(this.connectError);
    const connection = this.#connection(deviceId);
    if (!this.holdConnect) return Promise.resolve(connection);
    return new Promise((resolve) => {
      this.#pendingConnect = resolve;
    });
  });

  public releaseConnect(deviceId = 'bike-1'): void {
    this.#pendingConnect?.(this.#connection(deviceId));
    this.#pendingConnect = null;
  }

  public found(device: ScannedDevice): void {
    this.#onDevice?.(device);
  }

  public scanFails(): void {
    this.#onScanError?.(new Error('scan failed'));
  }

  public notify(bytes: Uint8Array): void {
    this.#onValue?.(bytes);
  }

  public dropLink(): void {
    this.#onDisconnected?.();
  }

  public monitorFails(): void {
    this.#onMonitorError?.(new Error('monitor failed'));
  }

  #connection(deviceId: string): BleConnection {
    return {
      deviceId,
      characteristics: () => Promise.resolve(this.characteristicUuids),
      monitor: (_service, characteristic, onValue, onError) => {
        this.monitored = characteristic;
        this.#onValue = onValue;
        this.#onMonitorError = onError;
        return () => {
          this.#onValue = null;
          this.#onMonitorError = null;
        };
      },
      onDisconnected: (listener) => {
        this.#onDisconnected = listener;
        return () => {
          this.#onDisconnected = null;
        };
      },
      disconnect: () => {
        this.disconnects += 1;
        return Promise.resolve();
      },
    };
  }
}

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

interface Listener {
  readonly onValue: (bytes: Uint8Array) => void;
  readonly onError: (error: unknown) => void;
}

/** In-memory BLE transport the tests drive by hand. */
export class FakeTransport implements BleTransport {
  public readiness: BleReadiness = 'ready';
  public characteristicUuids: readonly string[] = [];
  public connectError: Error | null = null;
  public scanning = false;
  public disconnects = 0;
  /** Characteristic values returned by `read`; a missing one rejects. */
  public readonly values = new Map<string, Uint8Array>();
  /** Every write with response, in order. */
  public readonly writes: { readonly uuid: string; readonly bytes: Uint8Array }[] = [];
  /** Rejects every write when set. */
  public writeError: Error | null = null;
  /** Leaves writes unacknowledged until `ackWrites()`. */
  public holdWrites = false;
  /**
   * Answers each acknowledged write: the returned bytes are indicated on
   * the written characteristic; null sends nothing.
   */
  public respond: ((uuid: string, bytes: Uint8Array) => Uint8Array | null) | null = null;
  readonly #monitors = new Map<string, Listener>();
  readonly #indications = new Map<string, Listener>();
  #heldWrites: (() => void)[] = [];
  #onDevice: ((device: ScannedDevice) => void) | null = null;
  #onScanError: ((error: unknown) => void) | null = null;
  #onDisconnected: (() => void) | null = null;
  #pendingConnect: ((connection: BleConnection) => void) | null = null;
  public holdConnect = false;

  /** First characteristic still monitored (the machine or strap data), or null. */
  public get monitored(): string | null {
    return this.#monitors.keys().next().value ?? null;
  }

  public isMonitored(uuid: string): boolean {
    return this.#monitors.has(uuid);
  }

  public isIndicated(uuid: string): boolean {
    return this.#indications.has(uuid);
  }

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

  /** Notifies `uuid`, or the first monitored characteristic. */
  public notify(bytes: Uint8Array, uuid: string | null = this.monitored): void {
    if (uuid !== null) this.#monitors.get(uuid)?.onValue(bytes);
  }

  public indicate(uuid: string, bytes: Uint8Array): void {
    this.#indications.get(uuid)?.onValue(bytes);
  }

  public ackWrites(): void {
    const held = this.#heldWrites;
    this.#heldWrites = [];
    for (const ack of held) ack();
  }

  public dropLink(): void {
    this.#onDisconnected?.();
  }

  public monitorFails(): void {
    const uuid = this.monitored;
    if (uuid !== null) this.#monitors.get(uuid)?.onError(new Error('monitor failed'));
  }

  #subscribe(listeners: Map<string, Listener>): BleConnection['monitor'] {
    return (_service, characteristic, onValue, onError) => {
      const listener = { onValue, onError };
      listeners.set(characteristic, listener);
      return () => {
        if (listeners.get(characteristic) === listener) listeners.delete(characteristic);
      };
    };
  }

  #write(uuid: string, bytes: Uint8Array): Promise<void> {
    this.writes.push({ uuid, bytes });
    if (this.writeError !== null) return Promise.reject(this.writeError);
    return new Promise((resolve) => {
      const ack = (): void => {
        resolve();
        const answer = this.respond?.(uuid, bytes) ?? null;
        if (answer !== null) {
          // The indication follows the write acknowledgement.
          queueMicrotask(() => {
            this.indicate(uuid, answer);
          });
        }
      };
      if (this.holdWrites) this.#heldWrites.push(ack);
      else ack();
    });
  }

  #connection(deviceId: string): BleConnection {
    return {
      deviceId,
      characteristics: () => Promise.resolve(this.characteristicUuids),
      monitor: this.#subscribe(this.#monitors),
      indicate: this.#subscribe(this.#indications),
      read: (_service, characteristic) => {
        const value = this.values.get(characteristic);
        return value === undefined
          ? Promise.reject(new Error('read failed'))
          : Promise.resolve(value);
      },
      writeWithResponse: (_service, characteristic, bytes) => this.#write(characteristic, bytes),
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

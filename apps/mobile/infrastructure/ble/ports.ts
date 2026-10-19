/**
 * Bluetooth Low Energy port. The FTMS controller only sees this interface,
 * so it runs in Node tests against a fake; `ble-plx-transport.ts` adapts
 * `react-native-ble-plx` on device. UUIDs are lowercase 128-bit strings.
 */

/** Adapter readiness after the permission prompt. */
export type BleReadiness = 'ready' | 'poweredOff' | 'unauthorized' | 'unsupported';

export interface ScannedDevice {
  readonly id: string;
  /** Advertised name, or null when the device sends none. */
  readonly name: string | null;
}

export interface BleConnection {
  readonly deviceId: string;
  /** Characteristic UUIDs of a service, after discovery. */
  readonly characteristics: (serviceUuid: string) => Promise<readonly string[]>;
  /** Subscribes to notifications; returns the unsubscribe function. */
  readonly monitor: (
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (bytes: Uint8Array) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  /**
   * Subscribes to indications (acknowledged notifications), as the FTMS
   * Control Point answers; returns the unsubscribe function.
   */
  readonly indicate: (
    serviceUuid: string,
    characteristicUuid: string,
    onValue: (bytes: Uint8Array) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  /** Reads a characteristic value once. */
  readonly read: (serviceUuid: string, characteristicUuid: string) => Promise<Uint8Array>;
  /** Writes with response: resolves once the peripheral acknowledged the write. */
  readonly writeWithResponse: (
    serviceUuid: string,
    characteristicUuid: string,
    bytes: Uint8Array,
  ) => Promise<void>;
  /** Called once when the link drops for any reason other than `disconnect()`. */
  readonly onDisconnected: (listener: () => void) => () => void;
  readonly disconnect: () => Promise<void>;
}

export interface BleTransport {
  /** Requests the runtime permissions and waits for the adapter state to settle. */
  readonly prepare: () => Promise<BleReadiness>;
  /** Scans for devices advertising one of `serviceUuids`; returns the stop function. */
  readonly startScan: (
    serviceUuids: readonly string[],
    onDevice: (device: ScannedDevice) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  /** Connects and discovers services and characteristics. */
  readonly connect: (deviceId: string) => Promise<BleConnection>;
}

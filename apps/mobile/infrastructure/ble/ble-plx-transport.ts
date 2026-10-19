/**
 * `react-native-ble-plx` adapter for the {@link BleTransport} port.
 *
 * The manager is created lazily, on the first `prepare()`: on iOS creating
 * it shows the Bluetooth permission prompt, which must only happen when
 * the member opens the machine screen. Android 12+ needs the runtime
 * `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` permissions (declared with
 * `neverForLocation` by the config plugin); older Android versions need
 * the location permission to scan.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';

import { base64ToBytes } from './base64';

import type { BleConnection, BleReadiness, BleTransport } from './ports';

/** How long to wait for the adapter to leave `Unknown`/`Resetting`. */
const STATE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

let manager: BleManager | null = null;
/**
 * The manager runs one scan at a time and a new `startDeviceScan` takes
 * over the previous one (machine and heart-rate strap scans share it), so
 * only the latest scan may stop the radio or receive devices.
 */
let activeScan: object | null = null;

function getManager(): BleManager {
  manager ??= new BleManager();
  return manager;
}

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const permissions =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every(
    (permission) => results[permission] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

function toReadiness(state: State): BleReadiness | null {
  switch (state) {
    case State.PoweredOn:
      return 'ready';
    case State.PoweredOff:
      return 'poweredOff';
    case State.Unauthorized:
      return 'unauthorized';
    case State.Unsupported:
      return 'unsupported';
    default:
      return null;
  }
}

function settledState(ble: BleManager): Promise<BleReadiness> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (readiness: BleReadiness): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription.remove();
      resolve(readiness);
    };
    const timer = setTimeout(() => {
      finish('poweredOff');
    }, STATE_TIMEOUT_MS);
    const subscription = ble.onStateChange((state) => {
      const readiness = toReadiness(state);
      if (readiness !== null) finish(readiness);
    }, true);
  });
}

function createConnection(ble: BleManager, deviceId: string): BleConnection {
  let closing = false;
  return {
    deviceId,
    characteristics: async (serviceUuid) =>
      (await ble.characteristicsForDevice(deviceId, serviceUuid)).map((characteristic) =>
        characteristic.uuid.toLowerCase(),
      ),
    monitor: (serviceUuid, characteristicUuid, onValue, onError) => {
      const subscription = ble.monitorCharacteristicForDevice(
        deviceId,
        serviceUuid,
        characteristicUuid,
        (error, characteristic) => {
          if (error !== null) {
            if (!closing) onError(error);
            return;
          }
          const bytes = characteristic?.value == null ? null : base64ToBytes(characteristic.value);
          if (bytes !== null) onValue(bytes);
        },
      );
      return () => {
        subscription.remove();
      };
    },
    onDisconnected: (listener) => {
      const subscription = ble.onDeviceDisconnected(deviceId, () => {
        if (!closing) listener();
      });
      return () => {
        subscription.remove();
      };
    },
    disconnect: async () => {
      closing = true;
      try {
        await ble.cancelDeviceConnection(deviceId);
      } catch {
        // Already disconnected.
      }
    },
  };
}

export function createBlePlxTransport(): BleTransport {
  return {
    prepare: async () => {
      if (!(await requestAndroidPermissions())) return 'unauthorized';
      return settledState(getManager());
    },
    startScan: (serviceUuids, onDevice, onError) => {
      const ble = getManager();
      const scan = {};
      activeScan = scan;
      let stopped = false;
      ble
        .startDeviceScan([...serviceUuids], { allowDuplicates: false }, (error, device) => {
          if (stopped || activeScan !== scan) return;
          if (error !== null) {
            onError(error);
            return;
          }
          if (device !== null) onDevice({ id: device.id, name: device.name ?? device.localName });
        })
        .catch((error: unknown) => {
          if (!stopped && activeScan === scan) onError(error);
        });
      return () => {
        if (stopped) return;
        stopped = true;
        if (activeScan !== scan) return;
        activeScan = null;
        ble.stopDeviceScan().catch(() => {
          // Scan already stopped by the system.
        });
      };
    },
    connect: async (deviceId) => {
      const ble = getManager();
      await ble.connectToDevice(deviceId, { timeout: CONNECT_TIMEOUT_MS });
      try {
        await ble.discoverAllServicesAndCharacteristicsForDevice(deviceId);
      } catch (error) {
        // A failed discovery leaves the link open (Android): release it so a
        // retry, or another app, can connect.
        await ble.cancelDeviceConnection(deviceId).catch(() => {
          // Already disconnected.
        });
        throw error;
      }
      return createConnection(ble, deviceId);
    },
  };
}

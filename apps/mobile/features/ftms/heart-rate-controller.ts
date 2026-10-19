/**
 * Heart-rate strap controller — issue #669.
 *
 * Pairs a Heart Rate Service (0x180D) strap or watch through the same
 * {@link BleTransport} as the machine, on its own connection: losing the
 * strap never stops the machine session. The last strap is remembered on
 * this device only (its id and name, never readings), so the member can
 * reconnect without scanning. Readings stay in memory; only the session
 * summary is ever logged.
 */
import { Store } from '../store';

import { BleScan } from './ble-scan';
import {
  decodeHeartRateMeasurement,
  HEART_RATE_SERVICE,
  pickHeartRateCharacteristic,
  usableHeartRate,
  type HeartRateMeasurement,
} from './heart-rate';
import { fullUuid } from './protocol';

import type { FtmsController } from './ftms-controller';
import type {
  BleConnection,
  BleReadiness,
  BleTransport,
  ScannedDevice,
} from '../../infrastructure/ble/ports';
import type { KeyValueStore } from '../../infrastructure/storage/key-value-store';

export const LAST_STRAP_KEY = 'athlya.ble.heartRateStrap';

export type StrapStatus =
  'idle' | 'preparing' | 'scanning' | 'unavailable' | 'connecting' | 'connected';

export type StrapError = 'scanFailed' | 'connectFailed' | 'notHeartRate' | 'linkLost';

export interface StrapState {
  readonly status: StrapStatus;
  readonly readiness: Exclude<BleReadiness, 'ready'> | null;
  readonly devices: readonly ScannedDevice[];
  readonly nothingFound: boolean;
  readonly device: ScannedDevice | null;
  /** The strap paired last on this device, for a one-tap reconnect. */
  readonly remembered: ScannedDevice | null;
  /** Latest measurement while connected; null before the first one. */
  readonly reading: HeartRateMeasurement | null;
  readonly error: StrapError | null;
}

export const INITIAL_STRAP_STATE: StrapState = {
  status: 'idle',
  readiness: null,
  devices: [],
  nothingFound: false,
  device: null,
  remembered: null,
  reading: null,
  error: null,
};

export interface HeartRateControllerDeps {
  readonly transport: BleTransport;
  /** Where the last strap is remembered; nothing is remembered without it. */
  readonly preferences?: KeyValueStore;
}

const SERVICE_UUID = fullUuid(HEART_RATE_SERVICE);

function readRemembered(preferences: KeyValueStore | undefined): ScannedDevice | null {
  const raw = preferences?.getString(LAST_STRAP_KEY);
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { id, name } = value as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id === '') return null;
    return { id, name: typeof name === 'string' ? name : null };
  } catch {
    return null;
  }
}

export class HeartRateController {
  readonly #transport: BleTransport;
  readonly #preferences: KeyValueStore | undefined;
  readonly #store: Store<StrapState>;
  readonly #scan: BleScan;
  #generation = 0;
  #connection: BleConnection | null = null;
  #unsubscribers: (() => void)[] = [];

  public constructor(deps: HeartRateControllerDeps) {
    this.#transport = deps.transport;
    this.#preferences = deps.preferences;
    this.#scan = new BleScan(deps.transport);
    this.#store = new Store<StrapState>({
      ...INITIAL_STRAP_STATE,
      remembered: readRemembered(deps.preferences),
    });
  }

  public readonly get = (): StrapState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Asks for Bluetooth, then lists nearby heart-rate straps. */
  public async scan(): Promise<void> {
    if (!(await this.#prepare())) return;
    this.#store.set((state) => ({
      ...state,
      status: 'scanning',
      devices: [],
      nothingFound: false,
    }));
    this.#scan.start(
      [SERVICE_UUID],
      (device) => {
        this.#store.set((state) =>
          state.devices.some((known) => known.id === device.id)
            ? state
            : { ...state, devices: [...state.devices, device] },
        );
      },
      (failed) => {
        this.#endScan(failed ? 'scanFailed' : null);
      },
    );
  }

  public stopScan(): void {
    // A stopped scan did not conclude that nothing is nearby.
    if (this.get().status === 'scanning') this.#endScan(null, true);
  }

  /** Connects to the remembered strap without scanning. */
  public async reconnect(): Promise<void> {
    const { remembered } = this.get();
    if (remembered === null) return;
    if (!(await this.#prepare())) return;
    await this.connect(remembered.id);
  }

  public async connect(deviceId: string): Promise<void> {
    const { status, devices, remembered } = this.get();
    if (status === 'connecting' || status === 'connected') return;
    this.#scan.stop();
    const device = devices.find((candidate) => candidate.id === deviceId) ??
      (remembered?.id === deviceId ? remembered : null) ?? { id: deviceId, name: null };
    const generation = ++this.#generation;
    this.#store.set((state) => ({
      ...state,
      status: 'connecting',
      device,
      reading: null,
      error: null,
    }));

    let connection: BleConnection;
    try {
      connection = await this.#transport.connect(deviceId);
    } catch {
      if (generation === this.#generation) this.#fail('connectFailed');
      return;
    }
    if (generation !== this.#generation) {
      void connection.disconnect();
      return;
    }
    this.#connection = connection;

    let uuid: string | null;
    try {
      uuid = pickHeartRateCharacteristic(await connection.characteristics(SERVICE_UUID));
    } catch {
      uuid = null;
    }
    if (generation !== this.#generation) return;
    if (uuid === null) {
      this.#teardown();
      this.#fail('notHeartRate');
      return;
    }

    this.#remember(device);
    this.#store.set((state) => ({ ...state, status: 'connected', remembered: device }));
    this.#unsubscribers.push(
      connection.onDisconnected(() => {
        if (generation === this.#generation) this.#linkLost();
      }),
      connection.monitor(
        SERVICE_UUID,
        uuid,
        (bytes) => {
          if (generation !== this.#generation) return;
          const reading = decodeHeartRateMeasurement(bytes);
          if (reading !== null) this.#store.set((state) => ({ ...state, reading }));
        },
        () => {
          if (generation === this.#generation) this.#linkLost();
        },
      ),
    );
  }

  /** Releases the strap; it stays remembered. */
  public disconnect(): void {
    this.#generation += 1;
    this.#scan.stop();
    this.#teardown();
    this.#store.set((state) => ({
      ...state,
      status: 'idle',
      device: null,
      reading: null,
      error: null,
    }));
  }

  /** Disconnects and forgets the remembered strap. */
  public forget(): void {
    this.disconnect();
    this.#preferences?.remove(LAST_STRAP_KEY);
    this.#store.set((state) => ({ ...state, remembered: null }));
  }

  /** The screen went away: nothing keeps scanning or holds the strap. */
  public dispose(): void {
    this.#generation += 1;
    this.#scan.stop();
    this.#teardown();
  }

  /** Resolves true once Bluetooth is ready; reports why not otherwise. */
  async #prepare(): Promise<boolean> {
    const { status } = this.get();
    if (status !== 'idle' && status !== 'unavailable') return false;
    const generation = this.#generation;
    this.#store.set((state) => ({ ...state, status: 'preparing', readiness: null, error: null }));
    let readiness: BleReadiness;
    try {
      readiness = await this.#transport.prepare();
    } catch {
      readiness = 'unsupported';
    }
    if (generation !== this.#generation) return false;
    if (readiness !== 'ready') {
      this.#store.set((state) => ({ ...state, status: 'unavailable', readiness }));
      return false;
    }
    return true;
  }

  #remember(device: ScannedDevice): void {
    try {
      this.#preferences?.set(LAST_STRAP_KEY, JSON.stringify({ id: device.id, name: device.name }));
    } catch {
      // Remembering is a convenience: a storage failure must not break pairing.
    }
  }

  #endScan(error: StrapError | null, stopped = false): void {
    this.#scan.stop();
    this.#store.set((state) =>
      state.status === 'scanning'
        ? {
            ...state,
            status: 'idle',
            nothingFound: !stopped && error === null && state.devices.length === 0,
            error,
          }
        : state,
    );
  }

  #linkLost(): void {
    this.#generation += 1;
    this.#teardown();
    this.#store.set((state) => ({
      ...state,
      status: 'idle',
      device: null,
      reading: null,
      error: 'linkLost',
    }));
  }

  #fail(error: StrapError): void {
    this.#store.set((state) => ({ ...state, status: 'idle', device: null, error }));
  }

  #teardown(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    const connection = this.#connection;
    this.#connection = null;
    if (connection !== null) void connection.disconnect();
  }
}

/**
 * Feeds the strap's heart rate into the machine session: every new
 * reading (null once contact or the link is lost) goes to
 * {@link FtmsController.strapHeartRate}. Returns the unsubscribe function.
 */
export function linkStrapToMachine(
  strap: Pick<HeartRateController, 'get' | 'subscribe'>,
  machine: Pick<FtmsController, 'strapHeartRate'>,
): () => void {
  let last = strap.get().reading;
  return strap.subscribe(() => {
    const { reading } = strap.get();
    if (reading === last) return;
    last = reading;
    machine.strapHeartRate(reading === null ? null : usableHeartRate(reading));
  });
}

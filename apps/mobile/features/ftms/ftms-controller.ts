/**
 * FTMS machine screen controller — task 23.1.
 *
 * Drives the BLE port through scan → connect → stream → finish and keeps
 * the live session in a {@link Store} the screen subscribes to. Data
 * recorded before an unexpected disconnect is kept so the member can
 * still log it. Every async step checks a generation counter, so a
 * connection that completes after `reset()`/`dispose()` is closed instead
 * of being adopted.
 */
import { Store } from '../store';

import { BleScan } from './ble-scan';
import {
  addHeartRate,
  addSample,
  createLiveSession,
  endSession,
  releaseHeartRate,
  summarise,
  type LiveSession,
  type SessionSummary,
} from './live-session';
import { decodeMachineData, FTMS_SERVICE, fullUuid, pickMachineCharacteristic } from './protocol';

import type {
  BleConnection,
  BleReadiness,
  BleTransport,
  ScannedDevice,
} from '../../infrastructure/ble/ports';

export { SCAN_TIMEOUT_MS } from './ble-scan';

export type MachineStatus =
  | 'idle'
  | 'preparing'
  | 'scanning'
  | 'unavailable'
  | 'connecting'
  | 'streaming'
  | 'disconnected'
  | 'finished';

export type MachineError = 'scanFailed' | 'connectFailed' | 'notFtms' | 'linkLost';

export interface MachineState {
  readonly status: MachineStatus;
  /** Why Bluetooth cannot be used, when `status` is `unavailable`. */
  readonly readiness: Exclude<BleReadiness, 'ready'> | null;
  readonly devices: readonly ScannedDevice[];
  /** True once a scan ended without finding any machine. */
  readonly nothingFound: boolean;
  readonly device: ScannedDevice | null;
  readonly session: LiveSession | null;
  readonly error: MachineError | null;
}

export const INITIAL_MACHINE_STATE: MachineState = {
  status: 'idle',
  readiness: null,
  devices: [],
  nothingFound: false,
  device: null,
  session: null,
  error: null,
};

export interface FtmsControllerDeps {
  readonly transport: BleTransport;
  /** Unix ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

const SERVICE_UUID = fullUuid(FTMS_SERVICE);

export class FtmsController {
  readonly #transport: BleTransport;
  readonly #now: () => number;
  readonly #store = new Store<MachineState>(INITIAL_MACHINE_STATE);
  readonly #scan: BleScan;
  #generation = 0;
  #connection: BleConnection | null = null;
  #unsubscribers: (() => void)[] = [];

  public constructor(deps: FtmsControllerDeps) {
    this.#transport = deps.transport;
    this.#now = deps.now ?? Date.now;
    this.#scan = new BleScan(deps.transport);
  }

  public readonly get = (): MachineState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /** Summary of the current session, or null before any data arrived. */
  public summary(): SessionSummary | null {
    const { session } = this.get();
    return session === null || session.samples === 0 ? null : summarise(session, this.#now());
  }

  /** Asks for Bluetooth, then lists nearby FTMS machines. */
  public async scan(): Promise<void> {
    const { status } = this.get();
    if (status === 'preparing' || status === 'scanning' || status === 'connecting') return;
    if (status === 'streaming') return;
    const generation = this.#generation;
    this.#store.set((state) => ({ ...state, status: 'preparing', readiness: null, error: null }));
    let readiness: BleReadiness;
    try {
      readiness = await this.#transport.prepare();
    } catch {
      readiness = 'unsupported';
    }
    if (generation !== this.#generation) return;
    if (readiness !== 'ready') {
      this.#store.set((state) => ({ ...state, status: 'unavailable', readiness }));
      return;
    }
    this.#store.set((state) => ({
      ...state,
      status: 'scanning',
      devices: [],
      nothingFound: false,
    }));
    this.#scan.start(
      [SERVICE_UUID],
      (device) => {
        this.#addDevice(device);
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

  public async connect(deviceId: string): Promise<void> {
    const { status, devices } = this.get();
    if (status === 'connecting' || status === 'streaming') return;
    this.#scan.stop();
    const device = devices.find((candidate) => candidate.id === deviceId) ?? {
      id: deviceId,
      name: null,
    };
    const generation = ++this.#generation;
    this.#store.set((state) => ({
      ...state,
      status: 'connecting',
      device,
      session: null,
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

    let picked: ReturnType<typeof pickMachineCharacteristic>;
    try {
      picked = pickMachineCharacteristic(await connection.characteristics(SERVICE_UUID));
    } catch {
      picked = null;
    }
    if (generation !== this.#generation) return;
    if (picked === null) {
      this.#teardown();
      this.#fail('notFtms');
      return;
    }

    const { machine, uuid } = picked;
    this.#store.set((state) => ({
      ...state,
      status: 'streaming',
      session: createLiveSession(machine, this.#now()),
    }));
    this.#unsubscribers.push(
      connection.onDisconnected(() => {
        if (generation === this.#generation) this.#linkLost();
      }),
      connection.monitor(
        SERVICE_UUID,
        uuid,
        (bytes) => {
          if (generation === this.#generation) this.#onData(bytes);
        },
        () => {
          if (generation === this.#generation) this.#linkLost();
        },
      ),
    );
  }

  /**
   * Heart rate from a paired strap, or null when it lost skin contact or
   * went away. While the strap reports, it wins over the machine's value.
   */
  public strapHeartRate(bpm: number | null): void {
    if (this.get().status !== 'streaming') return;
    const at = this.#now();
    this.#store.set((state) => {
      if (state.session === null) return state;
      const session =
        bpm === null ? releaseHeartRate(state.session, at) : addHeartRate(state.session, bpm, at);
      return session === state.session ? state : { ...state, session };
    });
  }

  /** Ends the session and releases the machine; the data stays for saving. */
  public finish(): void {
    const { status } = this.get();
    if (status !== 'streaming' && status !== 'disconnected') return;
    this.#generation += 1;
    this.#teardown();
    const at = this.#now();
    this.#store.set((state) => ({
      ...state,
      status: 'finished',
      session: state.session === null ? null : endSession(state.session, at),
    }));
  }

  /** Drops the session (after saving or discarding it). */
  public reset(): void {
    this.#generation += 1;
    this.#scan.stop();
    this.#teardown();
    this.#store.set(INITIAL_MACHINE_STATE);
  }

  /** The screen went away: nothing keeps scanning or holds the machine. */
  public dispose(): void {
    this.#generation += 1;
    this.#scan.stop();
    this.#teardown();
  }

  #addDevice(device: ScannedDevice): void {
    this.#store.set((state) =>
      state.devices.some((known) => known.id === device.id)
        ? state
        : { ...state, devices: [...state.devices, device] },
    );
  }

  #endScan(error: MachineError | null, stopped = false): void {
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

  #onData(bytes: Uint8Array): void {
    const { session } = this.get();
    if (session === null) return;
    const sample = decodeMachineData(session.machine, bytes);
    if (sample === null) return;
    this.#store.set((state) => ({ ...state, session: addSample(session, sample, this.#now()) }));
  }

  #linkLost(): void {
    this.#generation += 1;
    this.#teardown();
    const at = this.#now();
    this.#store.set((state) => ({
      ...state,
      status: 'disconnected',
      error: 'linkLost',
      session: state.session === null ? null : endSession(state.session, at),
    }));
  }

  #fail(error: MachineError): void {
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

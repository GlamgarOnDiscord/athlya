/**
 * FTMS machine control — issue #668.
 *
 * Attached by {@link FtmsController} to the machine's connection once it
 * streams. It reads which targets the machine accepts and their ranges,
 * then drives the Fitness Machine Control Point: Request Control first,
 * then target resistance, target power (ERG), start, pause and stop. One
 * request is in flight at a time, as the FTMS procedure requires, and each
 * one waits for its Response Code indication with a timeout. Failures are
 * surfaced in the state, never thrown. Targets are always fitted to the
 * advertised range before they are encoded, and a control without a
 * readable range is not offered.
 */
import { Store } from '../store';

import {
  clampToRange,
  CONTROL_POINT_CHARACTERISTIC,
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
  FEATURE_CHARACTERISTIC,
  POWER_RANGE_CHARACTERISTIC,
  RESISTANCE_RANGE_CHARACTERISTIC,
  STATUS_CHARACTERISTIC,
  type ControlRange,
  type MachineStatusEvent,
  type ResultCode,
  type TargetFeatures,
} from './control-point';
import { FTMS_SERVICE, fullUuid, normaliseUuid } from './protocol';

import type { BleConnection } from '../../infrastructure/ble/ports';

/** How long a request waits for its Response Code indication. */
export const RESPONSE_TIMEOUT_MS = 5_000;
/** How long releasing control may delay the disconnect. */
export const RELEASE_TIMEOUT_MS = 1_000;

/** Preferred stepper increments, rounded up to the machine's own increment. */
export const POWER_STEP_W = 5;
export const RESISTANCE_STEP_TENTHS = 10;

export type ControlStatus = 'unavailable' | 'idle' | 'requesting' | 'granted';

export type ControlCommand =
  'requestControl' | 'reset' | 'resistance' | 'power' | 'start' | 'pause' | 'stop';

export type ControlError =
  'notPermitted' | 'notSupported' | 'invalidParameter' | 'failed' | 'timeout' | 'controlLost';

export type RunState = 'started' | 'paused' | 'stopped';

export interface ControlCapabilities {
  /** Supported Resistance Level Range in 0.1 steps; null when not offered. */
  readonly resistance: ControlRange | null;
  /** Supported Power Range in watts; null when not offered. */
  readonly power: ControlRange | null;
  readonly startStop: boolean;
}

export interface ControlState {
  /** `unavailable` when the machine has no Control Point or is not attached. */
  readonly status: ControlStatus;
  readonly capabilities: ControlCapabilities;
  /** Last target the machine confirmed or reported, in 0.1 steps. */
  readonly targetResistance: number | null;
  readonly targetPowerW: number | null;
  readonly run: RunState | null;
  /** Request awaiting its response; every control is disabled meanwhile. */
  readonly pending: ControlCommand | null;
  readonly error: ControlError | null;
}

export const NO_CAPABILITIES: ControlCapabilities = {
  resistance: null,
  power: null,
  startStop: false,
};

export const INITIAL_CONTROL_STATE: ControlState = {
  status: 'unavailable',
  capabilities: NO_CAPABILITIES,
  targetResistance: null,
  targetPowerW: null,
  run: null,
  pending: null,
  error: null,
};

type Outcome = ResultCode | 'timeout' | 'linkLost';

interface PendingRequest {
  readonly opCode: number;
  readonly finish: (outcome: Outcome) => void;
}

const SERVICE_UUID = fullUuid(FTMS_SERVICE);
const CONTROL_POINT_UUID = fullUuid(CONTROL_POINT_CHARACTERISTIC);
const FEATURE_UUID = fullUuid(FEATURE_CHARACTERISTIC);
const RESISTANCE_RANGE_UUID = fullUuid(RESISTANCE_RANGE_CHARACTERISTIC);
const POWER_RANGE_UUID = fullUuid(POWER_RANGE_CHARACTERISTIC);
const STATUS_UUID = fullUuid(STATUS_CHARACTERISTIC);

/** Stepper increment: `preferred` rounded up to a multiple of the range step. */
export function stepSize(range: ControlRange, preferred: number): number {
  return range.step * Math.max(1, Math.ceil(preferred / range.step));
}

/** Whether a stepper press in `direction` can still move `target` within `range`. */
export function canStep(range: ControlRange, target: number | null, direction: 1 | -1): boolean {
  if (target === null) return true;
  return direction === 1
    ? target < clampToRange(Number.POSITIVE_INFINITY, range)
    : target > range.min;
}

export class MachineControl {
  readonly #store = new Store<ControlState>(INITIAL_CONTROL_STATE);
  #connection: BleConnection | null = null;
  #token: object | null = null;
  #pending: PendingRequest | null = null;
  #unsubscribers: (() => void)[] = [];

  public readonly get = (): ControlState => this.#store.get();

  public readonly subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  /**
   * Discovers what the machine lets the app control. Never throws: a
   * machine without a Control Point simply stays `unavailable`.
   */
  public async attach(
    connection: BleConnection,
    characteristicUuids: readonly string[],
  ): Promise<void> {
    this.#forget();
    const token = {};
    this.#token = token;
    const present = new Set(characteristicUuids.map(normaliseUuid));
    if (!present.has(CONTROL_POINT_UUID)) return;
    this.#connection = connection;

    const read = async <T>(uuid: string, decode: (bytes: Uint8Array) => T | null) => {
      if (!present.has(uuid)) return null;
      try {
        return decode(await connection.read(SERVICE_UUID, uuid));
      } catch {
        return null;
      }
    };
    const features: TargetFeatures | null = await read(FEATURE_UUID, decodeTargetFeatures);
    const resistance =
      features?.resistance === true ? await read(RESISTANCE_RANGE_UUID, decodeRange) : null;
    const power = features?.power === true ? await read(POWER_RANGE_UUID, decodeRange) : null;
    if (this.#token !== token) return;

    try {
      this.#unsubscribers.push(
        connection.indicate(
          SERVICE_UUID,
          CONTROL_POINT_UUID,
          (bytes) => {
            if (this.#token === token) this.#onResponse(bytes);
          },
          () => {
            // A lost link is reported by the machine connection; a request
            // that gets no answer times out.
          },
        ),
      );
      if (present.has(STATUS_UUID)) {
        this.#unsubscribers.push(
          connection.monitor(
            SERVICE_UUID,
            STATUS_UUID,
            (bytes) => {
              if (this.#token === token) this.#onStatus(bytes);
            },
            () => {
              // Status is informative only.
            },
          ),
        );
      }
    } catch {
      this.#forget();
      return;
    }
    this.#store.set({
      ...INITIAL_CONTROL_STATE,
      status: 'idle',
      capabilities: { resistance, power, startStop: true },
    });
  }

  /**
   * Forgets the connection and settles any request in flight. With
   * `release`, a granted control is handed back with a Reset (which also
   * clears the targets): the returned promise settles once it was written,
   * or after {@link RELEASE_TIMEOUT_MS}; null when there was nothing to release.
   */
  public detach(release: boolean): Promise<void> | null {
    const connection = this.#connection;
    const granted = this.get().status === 'granted';
    this.#forget();
    if (!release || !granted || connection === null) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      connection
        .writeWithResponse(SERVICE_UUID, CONTROL_POINT_UUID, encodeReset())
        .then(done, done);
    });
  }

  #forget(): void {
    this.#token = null;
    this.#connection = null;
    this.#pending?.finish('linkLost');
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.#store.set(INITIAL_CONTROL_STATE);
  }

  public async requestControl(): Promise<void> {
    const state = this.get();
    if (state.status !== 'idle' || state.pending !== null) return;
    const token = this.#token;
    this.#store.set((current) => ({
      ...current,
      status: 'requesting',
      pending: 'requestControl',
      error: null,
    }));
    const outcome = await this.#send(encodeRequestControl());
    if (this.#token !== token || outcome === 'linkLost') return;
    const error: ControlError | null = outcome === 'success' ? null : outcome;
    this.#store.set((current) => ({
      ...current,
      status: error === null ? 'granted' : 'idle',
      pending: null,
      error,
    }));
  }

  /** Resets the machine's targets; control must be requested again afterwards. */
  public async reset(): Promise<void> {
    await this.#run('reset', encodeReset(), (state) => ({
      ...state,
      status: 'idle',
      targetResistance: null,
      targetPowerW: null,
      run: null,
    }));
  }

  /** Sets the target power in watts (ERG), fitted to the supported range. */
  public async setTargetPower(watts: number): Promise<void> {
    const range = this.get().capabilities.power;
    if (range === null) return;
    const target = clampToRange(Math.round(watts), range);
    await this.#run('power', encodeTargetPower(target), (state) => ({
      ...state,
      targetPowerW: target,
    }));
  }

  /** Sets the target resistance level in 0.1 steps, fitted to the supported range. */
  public async setTargetResistance(tenths: number): Promise<void> {
    const range = this.get().capabilities.resistance;
    if (range === null) return;
    const target = clampToRange(Math.round(tenths), range);
    const apply = (state: ControlState): ControlState => ({ ...state, targetResistance: target });
    const legacy = encodeLegacyTargetResistance(target);
    await this.#run('resistance', encodeTargetResistance(target), apply, legacy);
  }

  /**
   * Moves the target power one step up or down from the current target,
   * or from `fallbackW` (the measured power) before any target was set.
   */
  public async stepPower(direction: 1 | -1, fallbackW: number | null = null): Promise<void> {
    const { capabilities, targetPowerW } = this.get();
    const range = capabilities.power;
    if (range === null) return;
    const base = clampToRange(targetPowerW ?? fallbackW ?? range.min, range);
    await this.setTargetPower(base + direction * stepSize(range, POWER_STEP_W));
  }

  /** Moves the target resistance one step up or down. */
  public async stepResistance(
    direction: 1 | -1,
    fallbackTenths: number | null = null,
  ): Promise<void> {
    const { capabilities, targetResistance } = this.get();
    const range = capabilities.resistance;
    if (range === null) return;
    const base = clampToRange(targetResistance ?? fallbackTenths ?? range.min, range);
    await this.setTargetResistance(base + direction * stepSize(range, RESISTANCE_STEP_TENTHS));
  }

  public async start(): Promise<void> {
    await this.#run('start', encodeStartOrResume(), (state) => ({ ...state, run: 'started' }));
  }

  public async pause(): Promise<void> {
    await this.#run('pause', encodeStopOrPause('pause'), (state) => ({ ...state, run: 'paused' }));
  }

  public async stop(): Promise<void> {
    await this.#run('stop', encodeStopOrPause('stop'), (state) => ({ ...state, run: 'stopped' }));
  }

  async #run(
    command: Exclude<ControlCommand, 'requestControl'>,
    request: Uint8Array,
    onSuccess: (state: ControlState) => ControlState,
    retry: Uint8Array | null = null,
  ): Promise<void> {
    const state = this.get();
    if (state.status !== 'granted' || state.pending !== null) return;
    const token = this.#token;
    this.#store.set((current) => ({ ...current, pending: command, error: null }));
    let outcome = await this.#send(request);
    if (this.#token !== token || outcome === 'linkLost') return;
    // Machines following FTMS 1.0 reject the longer resistance parameter.
    if (outcome === 'invalidParameter' && retry !== null) {
      outcome = await this.#send(retry);
      if (this.#token !== token || outcome === 'linkLost') return;
    }
    if (outcome === 'success') {
      this.#store.set((current) => ({ ...onSuccess(current), pending: null }));
      return;
    }
    const error: ControlError = outcome;
    this.#store.set((current) => ({
      ...current,
      pending: null,
      error,
      // The machine took control back: the member must request it again.
      status: error === 'notPermitted' ? 'idle' : current.status,
      capabilities:
        error === 'notSupported'
          ? withoutCommand(current.capabilities, command)
          : current.capabilities,
    }));
  }

  /** Writes one request and waits for its Response Code indication. */
  #send(request: Uint8Array): Promise<Outcome> {
    const connection = this.#connection;
    if (connection === null || this.#pending !== null) return Promise.resolve('linkLost');
    return new Promise((resolve) => {
      const finish = (outcome: Outcome): void => {
        if (this.#pending !== pending) return;
        clearTimeout(timer);
        this.#pending = null;
        resolve(outcome);
      };
      const pending: PendingRequest = { opCode: request[0] ?? -1, finish };
      this.#pending = pending;
      const timer = setTimeout(() => {
        finish('timeout');
      }, RESPONSE_TIMEOUT_MS);
      connection.writeWithResponse(SERVICE_UUID, CONTROL_POINT_UUID, request).catch(() => {
        finish('failed');
      });
    });
  }

  #onResponse(bytes: Uint8Array): void {
    const response = decodeControlResponse(bytes);
    const pending = this.#pending;
    if (response === null || pending === null) return;
    if (response.requestOpCode === pending.opCode) pending.finish(response.result);
  }

  #onStatus(bytes: Uint8Array): void {
    const event = decodeMachineStatus(bytes);
    if (event === null) return;
    this.#store.set((state) => applyStatus(state, event));
  }
}

function withoutCommand(
  capabilities: ControlCapabilities,
  command: ControlCommand,
): ControlCapabilities {
  switch (command) {
    case 'resistance':
      return { ...capabilities, resistance: null };
    case 'power':
      return { ...capabilities, power: null };
    case 'start':
    case 'pause':
    case 'stop':
      return { ...capabilities, startStop: false };
    default:
      return capabilities;
  }
}

function applyStatus(state: ControlState, event: MachineStatusEvent): ControlState {
  switch (event.kind) {
    case 'reset':
      return {
        ...state,
        status: state.status === 'granted' ? 'idle' : state.status,
        targetResistance: null,
        targetPowerW: null,
        run: null,
      };
    case 'controlLost':
      return state.status === 'granted'
        ? { ...state, status: 'idle', error: 'controlLost' }
        : state;
    case 'started':
    case 'paused':
    case 'stopped':
      return { ...state, run: event.kind };
    case 'targetResistance':
      return { ...state, targetResistance: event.tenths };
    case 'targetPower':
      return { ...state, targetPowerW: event.watts };
  }
}

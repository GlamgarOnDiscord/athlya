/**
 * One bounded BLE scan, shared by the machine and heart-rate strap
 * controllers: it stops on its own after {@link SCAN_TIMEOUT_MS}
 * (battery), and a stale callback from a scan that was already stopped
 * or replaced is ignored.
 */
import type { BleTransport, ScannedDevice } from '../../infrastructure/ble/ports';

/** Scans stop on their own after this long (battery). */
export const SCAN_TIMEOUT_MS = 15_000;

export class BleScan {
  readonly #transport: BleTransport;
  #token: object | null = null;
  #stop: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(transport: BleTransport) {
    this.#transport = transport;
  }

  /**
   * Starts scanning for `serviceUuids`. `onEnd` runs once, when the scan
   * times out (`failed` false) or the radio reports an error (`failed`
   * true); it does not run after {@link stop}.
   */
  public start(
    serviceUuids: readonly string[],
    onDevice: (device: ScannedDevice) => void,
    onEnd: (failed: boolean) => void,
  ): void {
    this.stop();
    const token = {};
    this.#token = token;
    const end = (failed: boolean): void => {
      if (this.#token !== token) return;
      this.stop();
      onEnd(failed);
    };
    let stop: () => void;
    try {
      stop = this.#transport.startScan(
        serviceUuids,
        (device) => {
          if (this.#token === token) onDevice(device);
        },
        () => {
          end(true);
        },
      );
    } catch {
      end(true);
      return;
    }
    if (this.#token !== token) {
      stop();
      return;
    }
    this.#stop = stop;
    this.#timer = setTimeout(() => {
      end(false);
    }, SCAN_TIMEOUT_MS);
  }

  public stop(): void {
    this.#token = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const stop = this.#stop;
    this.#stop = null;
    stop?.();
  }
}

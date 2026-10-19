import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCAN_TIMEOUT_MS } from '../../features/ftms/ble-scan';
import { FtmsController } from '../../features/ftms/ftms-controller';
import {
  HeartRateController,
  LAST_STRAP_KEY,
  linkStrapToMachine,
} from '../../features/ftms/heart-rate-controller';
import { fullUuid } from '../../features/ftms/protocol';
import { createMemoryKeyValueStore } from '../../infrastructure/storage/key-value-store';
import { FakeTransport, hex } from '../ftms-helpers';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const STRAP = { id: 'strap-1', name: 'HRM-Pro' };
const BIKE = { id: 'bike-1', name: 'Smart Bike' };
const MEASUREMENT = fullUuid(0x2a37);
const BODY_SENSOR_LOCATION = fullUuid(0x2a38);

/** Settles pending promise callbacks under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

function setup(backing = new Map<string, string>()) {
  const transport = new FakeTransport();
  transport.characteristicUuids = [BODY_SENSOR_LOCATION, MEASUREMENT];
  const preferences = createMemoryKeyValueStore(backing);
  const strap = new HeartRateController({ transport, preferences });
  return { transport, strap, backing };
}

async function connected(backing?: Map<string, string>) {
  const ctx = setup(backing);
  await ctx.strap.scan();
  ctx.transport.found(STRAP);
  await ctx.strap.connect(STRAP.id);
  return ctx;
}

async function streamingMachine() {
  const transport = new FakeTransport();
  transport.characteristicUuids = [fullUuid(0x2ad2)];
  const machine = new FtmsController({ transport });
  await machine.scan();
  transport.found(BIKE);
  await machine.connect(BIKE.id);
  return { transport, machine };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HeartRateController — pairing', () => {
  it('reports Bluetooth unavailable without scanning', async () => {
    const { transport, strap } = setup();
    transport.readiness = 'poweredOff';
    await strap.scan();
    expect(strap.get()).toMatchObject({ status: 'unavailable', readiness: 'poweredOff' });
    expect(transport.startScan).not.toHaveBeenCalled();
  });

  it('scans for the Heart Rate Service and lists each strap once', async () => {
    const { transport, strap } = setup();
    await strap.scan();
    expect(transport.startScan.mock.calls[0]?.[0]).toEqual([fullUuid(0x180d)]);
    transport.found(STRAP);
    transport.found(STRAP);
    expect(strap.get().devices).toEqual([STRAP]);
  });

  it('stops after the scan timeout and says when nothing was found', async () => {
    const { transport, strap } = setup();
    await strap.scan();
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
    expect(transport.scanning).toBe(false);
    expect(strap.get()).toMatchObject({ status: 'idle', nothingFound: true });
  });

  it('surfaces scan errors and member stops', async () => {
    const { transport, strap } = setup();
    await strap.scan();
    transport.scanFails();
    expect(strap.get()).toMatchObject({ status: 'idle', error: 'scanFailed' });
    await strap.scan();
    transport.found(STRAP);
    strap.stopScan();
    expect(transport.scanning).toBe(false);
    expect(strap.get()).toMatchObject({ status: 'idle', nothingFound: false, devices: [STRAP] });
  });

  it('connects, monitors the measurement and remembers the strap', async () => {
    const { transport, strap, backing } = await connected();
    expect(transport.scanning).toBe(false);
    expect(transport.monitored).toBe(MEASUREMENT);
    expect(strap.get()).toMatchObject({ status: 'connected', device: STRAP, remembered: STRAP });
    expect(JSON.parse(backing.get(LAST_STRAP_KEY) ?? 'null')).toEqual(STRAP);

    transport.notify(hex('16 8c'));
    expect(strap.get().reading).toMatchObject({ bpm: 140, contact: 'detected' });
    // Malformed packets are dropped.
    transport.notify(hex('01 8c'));
    expect(strap.get().reading?.bpm).toBe(140);
  });

  it('rejects a device without a heart-rate measurement', async () => {
    const { transport, strap, backing } = setup();
    transport.characteristicUuids = [BODY_SENSOR_LOCATION];
    await strap.connect(STRAP.id);
    expect(strap.get()).toMatchObject({ status: 'idle', error: 'notHeartRate', device: null });
    expect(transport.disconnects).toBe(1);
    expect(backing.has(LAST_STRAP_KEY)).toBe(false);
  });

  it('reports a failed connection', async () => {
    const { transport, strap } = setup();
    transport.connectError = new Error('timeout');
    await strap.connect(STRAP.id);
    expect(strap.get()).toMatchObject({ status: 'idle', error: 'connectFailed' });
  });

  it('reconnects to the remembered strap without scanning, and forgets it', async () => {
    const backing = new Map([[LAST_STRAP_KEY, JSON.stringify(STRAP)]]);
    const { transport, strap } = setup(backing);
    expect(strap.get().remembered).toEqual(STRAP);
    await strap.reconnect();
    expect(transport.startScan).not.toHaveBeenCalled();
    expect(transport.prepare).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenCalledWith(STRAP.id);
    expect(strap.get()).toMatchObject({ status: 'connected', device: STRAP });

    strap.forget();
    expect(strap.get()).toMatchObject({ status: 'idle', remembered: null, device: null });
    expect(transport.disconnects).toBe(1);
    expect(backing.has(LAST_STRAP_KEY)).toBe(false);
  });

  it('ignores a corrupt remembered strap', () => {
    for (const raw of ['not json', '42', '{"id":""}', '{"name":"x"}']) {
      expect(setup(new Map([[LAST_STRAP_KEY, raw]])).strap.get().remembered).toBeNull();
    }
    expect(setup(new Map([[LAST_STRAP_KEY, '{"id":"s"}']])).strap.get().remembered).toEqual({
      id: 's',
      name: null,
    });
  });

  it('keeps nothing remembered without preferences', async () => {
    const transport = new FakeTransport();
    transport.characteristicUuids = [MEASUREMENT];
    const strap = new HeartRateController({ transport });
    await strap.connect(STRAP.id);
    expect(strap.get().status).toBe('connected');
  });

  it('reports a lost strap and drops its reading', async () => {
    const { transport, strap } = await connected();
    transport.notify(hex('16 8c'));
    transport.dropLink();
    expect(strap.get()).toMatchObject({ status: 'idle', error: 'linkLost', reading: null });
    transport.notify(hex('16 8c'));
    expect(strap.get().reading).toBeNull();
  });

  it('closes a connection that completes after the screen went away', async () => {
    const { transport, strap } = setup();
    transport.holdConnect = true;
    const pending = strap.connect(STRAP.id);
    strap.dispose();
    transport.releaseConnect(STRAP.id);
    await pending;
    await flush();
    expect(transport.disconnects).toBe(1);
    expect(transport.monitored).toBeNull();
  });
});

describe('strap and machine together', () => {
  it('feeds the strap heart rate into the machine session over the machine one', async () => {
    const { transport: bike, machine } = await streamingMachine();
    const { transport: belt, strap } = await connected();
    const unlink = linkStrapToMachine(strap, machine);

    // Indoor bike: power 200 W and grip heart rate 100 bpm.
    bike.notify(hex('4102 c800 64'));
    expect(machine.get().session?.latest.heartRateBpm).toBe(100);
    belt.notify(hex('16 8c'));
    expect(machine.get().session?.heartRateSource).toBe('strap');
    bike.notify(hex('4102 c800 64'));
    expect(machine.get().session?.latest).toEqual({ powerW: 200, heartRateBpm: 140 });

    // No skin contact: the machine's value is used again.
    belt.notify(hex('14 8c'));
    expect(machine.get().session?.heartRateSource).toBe('machine');
    bike.notify(hex('4102 c800 64'));
    expect(machine.get().session?.latest.heartRateBpm).toBe(100);

    unlink();
    belt.notify(hex('16 aa'));
    expect(machine.get().session?.heartRateSource).toBe('machine');
  });

  it('keeps the machine session running when the strap drops', async () => {
    const { transport: bike, machine } = await streamingMachine();
    const { transport: belt, strap } = await connected();
    linkStrapToMachine(strap, machine);
    belt.notify(hex('16 8c'));
    belt.dropLink();
    expect(strap.get().status).toBe('idle');
    expect(machine.get().status).toBe('streaming');
    expect(machine.get().session?.heartRateSource).toBe('machine');
    expect(bike.disconnects).toBe(0);
    bike.notify(hex('4100 c800'));
    expect(machine.get().session?.samples).toBe(2);
    expect(machine.summary()?.maxHeartRateBpm).toBe(140);
  });

  it('ignores strap readings when no machine session runs', async () => {
    const transport = new FakeTransport();
    const machine = new FtmsController({ transport });
    const { transport: belt, strap } = await connected();
    linkStrapToMachine(strap, machine);
    belt.notify(hex('16 8c'));
    expect(machine.get().session).toBeNull();
    expect(strap.get().reading?.bpm).toBe(140);
  });
});

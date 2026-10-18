import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FtmsController, SCAN_TIMEOUT_MS } from '../../features/ftms/ftms-controller';
import { fullUuid } from '../../features/ftms/protocol';
import { FakeTransport, hex } from '../ftms-helpers';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const BIKE = { id: 'bike-1', name: 'Smart Bike' };
const BIKE_DATA = fullUuid(0x2ad2);
const FEATURE = fullUuid(0x2acc);

/** Settles pending promise callbacks under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

function setup() {
  const transport = new FakeTransport();
  transport.characteristicUuids = [FEATURE, BIKE_DATA];
  const controller = new FtmsController({ transport });
  return { transport, controller };
}

async function streaming() {
  const ctx = setup();
  await ctx.controller.scan();
  ctx.transport.found(BIKE);
  await ctx.controller.connect(BIKE.id);
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FtmsController — scanning', () => {
  it.each(['poweredOff', 'unauthorized', 'unsupported'] as const)(
    'reports Bluetooth %s without scanning',
    async (readiness) => {
      const { transport, controller } = setup();
      transport.readiness = readiness;
      await controller.scan();
      expect(controller.get()).toMatchObject({ status: 'unavailable', readiness });
      expect(transport.startScan).not.toHaveBeenCalled();
    },
  );

  it('scans for the FTMS service and lists each machine once', async () => {
    const { transport, controller } = setup();
    await controller.scan();
    expect(controller.get().status).toBe('scanning');
    expect(transport.startScan.mock.calls[0]?.[0]).toEqual([fullUuid(0x1826)]);
    transport.found(BIKE);
    transport.found(BIKE);
    transport.found({ id: 'rower-1', name: null });
    expect(controller.get().devices).toEqual([BIKE, { id: 'rower-1', name: null }]);
  });

  it('stops after the scan timeout and says when nothing was found', async () => {
    const { transport, controller } = setup();
    await controller.scan();
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
    expect(transport.scanning).toBe(false);
    expect(controller.get()).toMatchObject({ status: 'idle', nothingFound: true });
  });

  it('surfaces scan errors', async () => {
    const { transport, controller } = setup();
    await controller.scan();
    transport.scanFails();
    expect(controller.get()).toMatchObject({ status: 'idle', error: 'scanFailed' });
    expect(transport.scanning).toBe(false);
  });

  it('can be stopped by the member', async () => {
    const { transport, controller } = setup();
    await controller.scan();
    transport.found(BIKE);
    controller.stopScan();
    expect(transport.scanning).toBe(false);
    expect(controller.get()).toMatchObject({ status: 'idle', nothingFound: false });
    expect(controller.get().devices).toEqual([BIKE]);
  });
});

describe('FtmsController — streaming', () => {
  it('connects, monitors the machine data characteristic and records samples', async () => {
    const { transport, controller } = await streaming();
    expect(transport.scanning).toBe(false);
    expect(transport.monitored).toBe(BIKE_DATA);
    expect(controller.get()).toMatchObject({ status: 'streaming', device: BIKE });
    expect(controller.get().session?.machine).toBe('indoorBike');

    transport.notify(hex('4000 f609 c800'));
    await vi.advanceTimersByTimeAsync(1_000);
    transport.notify(hex('4000 f609 c800'));
    // Malformed packets are dropped.
    transport.notify(hex('4000'));
    expect(controller.get().session?.samples).toBe(2);
    expect(controller.get().session?.latest).toEqual({ speedKmh: 25.5, powerW: 200 });
    expect(controller.summary()).toMatchObject({ elapsedSec: 1, avgPowerW: 200 });
  });

  it('rejects a device without an FTMS data characteristic', async () => {
    const { transport, controller } = setup();
    transport.characteristicUuids = [FEATURE];
    await controller.connect(BIKE.id);
    expect(controller.get()).toMatchObject({ status: 'idle', error: 'notFtms', session: null });
    expect(transport.disconnects).toBe(1);
  });

  it('reports a failed connection', async () => {
    const { transport, controller } = setup();
    transport.connectError = new Error('timeout');
    await controller.connect(BIKE.id);
    expect(controller.get()).toMatchObject({ status: 'idle', error: 'connectFailed' });
  });

  it('keeps the recorded data when the link drops', async () => {
    const { transport, controller } = await streaming();
    transport.notify(hex('4000 f609 c800'));
    transport.dropLink();
    expect(controller.get()).toMatchObject({ status: 'disconnected', error: 'linkLost' });
    expect(controller.get().session?.samples).toBe(1);
    // Late notifications from the dropped link are ignored.
    transport.notify(hex('4000 f609 c800'));
    expect(controller.get().session?.samples).toBe(1);
    expect(controller.summary()).not.toBeNull();
  });

  it('treats a monitor error as a lost link', async () => {
    const { transport, controller } = await streaming();
    transport.monitorFails();
    expect(controller.get().status).toBe('disconnected');
  });

  it('finishes by releasing the machine and keeping the session', async () => {
    const { transport, controller } = await streaming();
    transport.notify(hex('4000 f609 c800'));
    controller.finish();
    expect(controller.get().status).toBe('finished');
    expect(transport.disconnects).toBe(1);
    expect(controller.summary()).not.toBeNull();
    controller.reset();
    expect(controller.get()).toMatchObject({ status: 'idle', session: null, devices: [] });
  });

  it('has no summary before the first sample', async () => {
    const { controller } = await streaming();
    expect(controller.summary()).toBeNull();
  });

  it('closes a connection that completes after the screen went away', async () => {
    const { transport, controller } = setup();
    transport.holdConnect = true;
    const pending = controller.connect(BIKE.id);
    controller.dispose();
    transport.releaseConnect();
    await pending;
    await flush();
    expect(transport.disconnects).toBe(1);
    expect(transport.monitored).toBeNull();
  });

  it('dispose stops scanning and disconnects', async () => {
    const { transport, controller } = await streaming();
    controller.dispose();
    expect(transport.disconnects).toBe(1);

    const scanning = setup();
    await scanning.controller.scan();
    scanning.controller.dispose();
    expect(scanning.transport.scanning).toBe(false);
  });
});

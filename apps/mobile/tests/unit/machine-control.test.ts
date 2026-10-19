import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FtmsController } from '../../features/ftms/ftms-controller';
import { RELEASE_TIMEOUT_MS, RESPONSE_TIMEOUT_MS } from '../../features/ftms/machine-control';
import { fullUuid } from '../../features/ftms/protocol';
import { FakeTransport, hex } from '../ftms-helpers';

const BIKE = { id: 'bike-1', name: 'Smart Bike' };
const BIKE_DATA = fullUuid(0x2ad2);
const FEATURE = fullUuid(0x2acc);
const CONTROL_POINT = fullUuid(0x2ad9);
const STATUS = fullUuid(0x2ada);
const RESISTANCE_RANGE = fullUuid(0x2ad6);
const POWER_RANGE = fullUuid(0x2ad8);

const POWER = { min: 0, max: 1000, step: 1 };
const RESISTANCE = { min: 10, max: 200, step: 10 };

/** Settles pending promise callbacks under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/** Answers every Control Point request with `result` (1 = success). */
function answer(result: number) {
  return (uuid: string, bytes: Uint8Array): Uint8Array | null =>
    uuid === CONTROL_POINT ? Uint8Array.of(0x80, bytes[0] ?? 0, result) : null;
}

async function connected(configure?: (transport: FakeTransport) => void) {
  const transport = new FakeTransport();
  transport.characteristicUuids = [
    FEATURE,
    BIKE_DATA,
    CONTROL_POINT,
    STATUS,
    RESISTANCE_RANGE,
    POWER_RANGE,
  ];
  transport.values.set(FEATURE, hex('02400000 0c000000'));
  transport.values.set(POWER_RANGE, hex('0000 e803 0100'));
  transport.values.set(RESISTANCE_RANGE, hex('0a00 c800 0a00'));
  transport.respond = answer(0x01);
  configure?.(transport);
  const controller = new FtmsController({ transport });
  await controller.connect(BIKE.id);
  await flush();
  return { transport, controller, control: controller.control };
}

async function granted(configure?: (transport: FakeTransport) => void) {
  const ctx = await connected(configure);
  await ctx.control.requestControl();
  ctx.transport.writes.length = 0;
  return ctx;
}

const written = (transport: FakeTransport) =>
  transport.writes.map(({ bytes }) => Array.from(bytes));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MachineControl — discovery', () => {
  it('reads the supported targets and listens to the Control Point and status', async () => {
    const { transport, control } = await connected();
    expect(control.get()).toMatchObject({
      status: 'idle',
      capabilities: { power: POWER, resistance: RESISTANCE, startStop: true },
    });
    expect(transport.isIndicated(CONTROL_POINT)).toBe(true);
    expect(transport.isMonitored(STATUS)).toBe(true);
    expect(transport.monitored).toBe(BIKE_DATA);
    expect(transport.writes).toEqual([]);
  });

  it('stays unavailable on a machine without a Control Point', async () => {
    const { transport, control } = await connected((fake) => {
      fake.characteristicUuids = [FEATURE, BIKE_DATA];
    });
    expect(control.get().status).toBe('unavailable');
    expect(transport.isIndicated(CONTROL_POINT)).toBe(false);
  });

  it('hides targets the feature bits do not announce', async () => {
    const { control } = await connected((fake) => {
      fake.values.set(FEATURE, hex('02400000 04000000'));
    });
    expect(control.get().capabilities).toEqual({
      power: null,
      resistance: RESISTANCE,
      startStop: true,
    });
  });

  it('hides a target whose range cannot be read, so nothing is sent unbounded', async () => {
    const { control } = await connected((fake) => {
      fake.values.delete(POWER_RANGE);
      fake.values.set(RESISTANCE_RANGE, hex('c800 0a00 0a00'));
    });
    expect(control.get().capabilities).toMatchObject({ power: null, resistance: null });
  });

  it('offers only start and stop when the features cannot be read', async () => {
    const { control } = await connected((fake) => {
      fake.values.delete(FEATURE);
    });
    expect(control.get()).toMatchObject({
      status: 'idle',
      capabilities: { power: null, resistance: null, startStop: true },
    });
  });
});

describe('MachineControl — control permission', () => {
  it('requests control before any command', async () => {
    const { transport, control } = await connected();
    await control.setTargetPower(200);
    await control.start();
    expect(transport.writes).toEqual([]);

    await control.requestControl();
    expect(written(transport)).toEqual([[0x00]]);
    expect(control.get()).toMatchObject({ status: 'granted', pending: null, error: null });
  });

  it('reports a denied request', async () => {
    const { transport, control } = await connected((fake) => {
      fake.respond = answer(0x05);
    });
    await control.requestControl();
    expect(control.get()).toMatchObject({ status: 'idle', error: 'notPermitted' });
    await control.setTargetPower(200);
    expect(written(transport)).toEqual([[0x00]]);
  });

  it('reports a machine whose Control Point does not support the request', async () => {
    const { control } = await connected((fake) => {
      fake.respond = answer(0x02);
    });
    await control.requestControl();
    expect(control.get()).toMatchObject({ status: 'idle', error: 'notSupported' });
  });

  it('times out a request the machine never answers', async () => {
    const { control } = await connected((fake) => {
      fake.respond = null;
    });
    const request = control.requestControl();
    expect(control.get()).toMatchObject({ status: 'requesting', pending: 'requestControl' });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await request;
    expect(control.get()).toMatchObject({ status: 'idle', pending: null, error: 'timeout' });
  });

  it('reports a write the machine refused', async () => {
    const { control } = await connected((fake) => {
      fake.writeError = new Error('GATT error');
    });
    await control.requestControl();
    expect(control.get()).toMatchObject({ status: 'idle', error: 'failed' });
  });

  it('ignores a response to another request', async () => {
    const { transport, control } = await connected((fake) => {
      fake.respond = null;
    });
    const request = control.requestControl();
    await flush();
    transport.indicate(CONTROL_POINT, hex('80 05 01'));
    expect(control.get().status).toBe('requesting');
    transport.indicate(CONTROL_POINT, hex('80 00 01'));
    await request;
    expect(control.get().status).toBe('granted');
  });
});

describe('MachineControl — targets', () => {
  it('sets the target power (ERG), clamped to the supported range', async () => {
    const { transport, control } = await granted();
    await control.setTargetPower(250);
    await control.setTargetPower(5_000);
    await control.setTargetPower(-40);
    expect(written(transport)).toEqual([
      [0x05, 0xfa, 0x00],
      [0x05, 0xe8, 0x03],
      [0x05, 0x00, 0x00],
    ]);
    expect(control.get().targetPowerW).toBe(0);
  });

  it('sets the target resistance on the machine increment', async () => {
    const { transport, control } = await granted();
    await control.setTargetResistance(87);
    expect(written(transport)).toEqual([[0x04, 90, 0x00]]);
    expect(control.get().targetResistance).toBe(90);
  });

  it('retries the FTMS 1.0 resistance form when the machine rejects the long one', async () => {
    const { transport, control } = await granted((fake) => {
      fake.respond = (uuid, bytes) =>
        uuid === CONTROL_POINT
          ? Uint8Array.of(
              0x80,
              bytes[0] ?? 0,
              bytes[0] === 0x04 && bytes.length === 3 ? 0x03 : 0x01,
            )
          : null;
    });
    await control.setTargetResistance(120);
    expect(written(transport)).toEqual([
      [0x04, 120, 0x00],
      [0x04, 120],
    ]);
    expect(control.get()).toMatchObject({ targetResistance: 120, error: null });
  });

  it('reports an invalid parameter', async () => {
    const { transport, control } = await granted();
    transport.respond = answer(0x03);
    await control.setTargetPower(300);
    expect(control.get()).toMatchObject({ targetPowerW: null, error: 'invalidParameter' });
  });

  it('hides a control the machine says it does not support', async () => {
    const { transport, control } = await granted();
    transport.respond = answer(0x02);
    await control.setTargetPower(300);
    expect(control.get()).toMatchObject({ error: 'notSupported', status: 'granted' });
    expect(control.get().capabilities.power).toBeNull();
    await control.setTargetPower(300);
    expect(transport.writes).toHaveLength(1);
  });

  it('asks for control again when the machine took it back', async () => {
    const { transport, control } = await granted();
    transport.respond = answer(0x05);
    await control.setTargetPower(300);
    expect(control.get()).toMatchObject({ status: 'idle', error: 'notPermitted' });
  });

  it('steps from the measured power before any target, then from the target', async () => {
    const { transport, control } = await granted();
    await control.stepPower(1, 143);
    await control.stepPower(1, 143);
    await control.stepPower(-1);
    expect(written(transport)).toEqual([
      [0x05, 148, 0x00],
      [0x05, 153, 0x00],
      [0x05, 148, 0x00],
    ]);
  });

  it('never steps past the range', async () => {
    const { transport, control } = await granted();
    await control.stepResistance(-1);
    await control.setTargetResistance(200);
    await control.stepResistance(1);
    expect(written(transport)).toEqual([
      [0x04, 10, 0x00],
      [0x04, 200, 0x00],
      [0x04, 200, 0x00],
    ]);
  });

  it('runs one request at a time', async () => {
    const { transport, control } = await granted();
    transport.holdWrites = true;
    const first = control.setTargetPower(200);
    await control.setTargetPower(300);
    expect(written(transport)).toEqual([[0x05, 200, 0x00]]);
    expect(control.get().pending).toBe('power');
    transport.ackWrites();
    await first;
    expect(control.get()).toMatchObject({ pending: null, targetPowerW: 200 });
  });
});

describe('MachineControl — start, pause, stop and reset', () => {
  it('starts, pauses and stops the machine', async () => {
    const { transport, control } = await granted();
    await control.start();
    expect(control.get().run).toBe('started');
    await control.pause();
    expect(control.get().run).toBe('paused');
    await control.stop();
    expect(control.get().run).toBe('stopped');
    expect(written(transport)).toEqual([[0x07], [0x08, 0x02], [0x08, 0x01]]);
  });

  it('resets the targets and gives control back', async () => {
    const { transport, control } = await granted();
    await control.setTargetPower(200);
    await control.reset();
    expect(written(transport).at(-1)).toEqual([0x01]);
    expect(control.get()).toMatchObject({ status: 'idle', targetPowerW: null });
  });

  it('hides start and stop when the machine does not support them', async () => {
    const { transport, control } = await granted();
    transport.respond = answer(0x02);
    await control.start();
    expect(control.get().capabilities.startStop).toBe(false);
  });
});

describe('MachineControl — Fitness Machine Status', () => {
  it('follows changes made on the console', async () => {
    const { transport, control } = await granted();
    transport.notify(hex('08 c800'), STATUS);
    transport.notify(hex('07 32'), STATUS);
    transport.notify(hex('04'), STATUS);
    expect(control.get()).toMatchObject({
      targetPowerW: 200,
      targetResistance: 50,
      run: 'started',
    });
    transport.notify(hex('02 02'), STATUS);
    expect(control.get().run).toBe('paused');
    transport.notify(hex('03 01'), STATUS);
    expect(control.get().run).toBe('stopped');
  });

  it('drops control when the machine revokes it', async () => {
    const { transport, control } = await granted();
    transport.notify(hex('ff'), STATUS);
    expect(control.get()).toMatchObject({ status: 'idle', error: 'controlLost' });
  });

  it('clears targets when the machine resets', async () => {
    const { transport, control } = await granted();
    await control.setTargetPower(200);
    transport.notify(hex('01'), STATUS);
    expect(control.get()).toMatchObject({ status: 'idle', targetPowerW: null });
  });
});

describe('MachineControl — releasing the machine', () => {
  it('settles a request in flight when the link drops, without writing again', async () => {
    const { transport, controller, control } = await granted();
    transport.holdWrites = true;
    const pending = control.setTargetPower(200);
    transport.dropLink();
    await pending;
    await flush();
    expect(control.get()).toMatchObject({ status: 'unavailable', pending: null });
    expect(controller.get().status).toBe('disconnected');
    expect(written(transport)).toEqual([[0x05, 200, 0x00]]);
    expect(transport.disconnects).toBe(1);
    expect(transport.isIndicated(CONTROL_POINT)).toBe(false);
  });

  it('settles a request in flight when the screen goes away', async () => {
    const { transport, controller, control } = await granted();
    transport.respond = null;
    const pending = control.start();
    controller.dispose();
    await pending;
    expect(control.get()).toMatchObject({ status: 'unavailable', pending: null, error: null });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    expect(control.get().error).toBeNull();
  });

  it('resets a granted machine before disconnecting on unmount', async () => {
    const { transport, controller, control } = await granted();
    await control.setTargetPower(200);
    controller.dispose();
    expect(written(transport).at(-1)).toEqual([0x01]);
    await flush();
    expect(transport.disconnects).toBe(1);
  });

  it('resets a granted machine when the session ends', async () => {
    const { transport, controller } = await granted();
    controller.finish();
    expect(written(transport)).toEqual([[0x01]]);
    await flush();
    expect(transport.disconnects).toBe(1);
  });

  it('does not wait forever for the release', async () => {
    const { transport, controller } = await granted();
    transport.holdWrites = true;
    controller.dispose();
    await flush();
    expect(transport.disconnects).toBe(0);
    await vi.advanceTimersByTimeAsync(RELEASE_TIMEOUT_MS);
    expect(transport.disconnects).toBe(1);
  });

  it('disconnects at once when control was never granted', async () => {
    const { transport, controller } = await connected();
    controller.dispose();
    expect(transport.writes).toEqual([]);
    expect(transport.disconnects).toBe(1);
  });
});

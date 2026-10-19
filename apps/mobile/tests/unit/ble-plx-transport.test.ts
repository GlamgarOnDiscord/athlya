import { beforeEach, describe, expect, it, vi } from 'vitest';

const manager = vi.hoisted(() => ({
  connectToDevice: vi.fn<(id: string) => Promise<unknown>>(),
  discoverAllServicesAndCharacteristicsForDevice: vi.fn<(id: string) => Promise<unknown>>(),
  cancelDeviceConnection: vi.fn<(id: string) => Promise<unknown>>(),
  startDeviceScan:
    vi.fn<
      (
        uuids: string[],
        options: unknown,
        listener: (error: unknown, device: { id: string; name: string | null } | null) => void,
      ) => Promise<void>
    >(),
  stopDeviceScan: vi.fn<() => Promise<void>>(),
  readCharacteristicForDevice:
    vi.fn<(id: string, service: string, uuid: string) => Promise<{ value: string | null }>>(),
  writeCharacteristicWithResponseForDevice:
    vi.fn<(id: string, service: string, uuid: string, value: string) => Promise<unknown>>(),
  monitorCharacteristicForDevice:
    vi.fn<
      (
        id: string,
        service: string,
        uuid: string,
        listener: (error: unknown, characteristic: { value: string | null } | null) => void,
        transactionId: string | undefined,
        subscriptionType: string | undefined,
      ) => { remove: () => void }
    >(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '18.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {}, requestMultiple: vi.fn() },
}));

vi.mock('react-native-ble-plx', () => ({
  BleManager: vi.fn(function BleManager() {
    return manager;
  }),
  State: {},
}));

const { createBlePlxTransport } = await import('../../infrastructure/ble/ble-plx-transport');

beforeEach(() => {
  vi.clearAllMocks();
  manager.connectToDevice.mockResolvedValue({});
  manager.cancelDeviceConnection.mockResolvedValue({});
  manager.startDeviceScan.mockResolvedValue(undefined);
  manager.stopDeviceScan.mockResolvedValue(undefined);
});

describe('react-native-ble-plx transport', () => {
  it('connects and discovers before handing out the connection', async () => {
    manager.discoverAllServicesAndCharacteristicsForDevice.mockResolvedValue({});
    const connection = await createBlePlxTransport().connect('bike-1');
    expect(connection.deviceId).toBe('bike-1');
    expect(manager.cancelDeviceConnection).not.toHaveBeenCalled();
  });

  it('releases the link when service discovery fails', async () => {
    const failure = new Error('discovery failed');
    manager.discoverAllServicesAndCharacteristicsForDevice.mockRejectedValue(failure);
    await expect(createBlePlxTransport().connect('bike-1')).rejects.toBe(failure);
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith('bike-1');
  });

  it('reports the discovery error even if the link is already gone', async () => {
    const failure = new Error('discovery failed');
    manager.discoverAllServicesAndCharacteristicsForDevice.mockRejectedValue(failure);
    manager.cancelDeviceConnection.mockRejectedValue(new Error('not connected'));
    await expect(createBlePlxTransport().connect('bike-1')).rejects.toBe(failure);
  });

  it('lets only the latest scan receive devices and stop the radio', () => {
    const transport = createBlePlxTransport();
    const machineDevices: string[] = [];
    const strapDevices: string[] = [];
    const stopMachine = transport.startScan(
      ['1826'],
      (device) => machineDevices.push(device.id),
      () => undefined,
    );
    const machineListener = manager.startDeviceScan.mock.calls[0]?.[2];
    const stopStrap = transport.startScan(
      ['180d'],
      (device) => strapDevices.push(device.id),
      () => undefined,
    );
    const strapListener = manager.startDeviceScan.mock.calls[1]?.[2];

    machineListener?.(null, { id: 'bike-1', name: null });
    strapListener?.(null, { id: 'strap-1', name: 'HRM' });
    expect(machineDevices).toEqual([]);
    expect(strapDevices).toEqual(['strap-1']);

    stopMachine();
    expect(manager.stopDeviceScan).not.toHaveBeenCalled();
    stopStrap();
    stopStrap();
    expect(manager.stopDeviceScan).toHaveBeenCalledOnce();
  });

  it('reads, writes with response and subscribes to indications', async () => {
    manager.discoverAllServicesAndCharacteristicsForDevice.mockResolvedValue({});
    manager.readCharacteristicForDevice.mockResolvedValue({ value: 'AAAAAAwAAAA=' });
    manager.writeCharacteristicWithResponseForDevice.mockResolvedValue({});
    const remove = vi.fn();
    manager.monitorCharacteristicForDevice.mockReturnValue({ remove });
    const connection = await createBlePlxTransport().connect('bike-1');

    await expect(connection.read('1826', '2acc')).resolves.toEqual(
      Uint8Array.of(0, 0, 0, 0, 0x0c, 0, 0, 0),
    );
    await connection.writeWithResponse('1826', '2ad9', Uint8Array.of(0x05, 0xfa, 0x00));
    expect(manager.writeCharacteristicWithResponseForDevice).toHaveBeenCalledWith(
      'bike-1',
      '1826',
      '2ad9',
      'BfoA',
    );

    const values: number[][] = [];
    const unsubscribe = connection.indicate(
      '1826',
      '2ad9',
      (bytes) => values.push(Array.from(bytes)),
      () => undefined,
    );
    const call = manager.monitorCharacteristicForDevice.mock.calls[0];
    expect(call?.[5]).toBe('indication');
    call?.[3](null, { value: 'gAUB' });
    expect(values).toEqual([[0x80, 0x05, 0x01]]);
    unsubscribe();
    expect(remove).toHaveBeenCalledOnce();

    connection.monitor(
      '1826',
      '2ada',
      () => undefined,
      () => undefined,
    );
    expect(manager.monitorCharacteristicForDevice.mock.calls[1]?.[5]).toBe('notification');
  });

  it('rejects a read without a value', async () => {
    manager.discoverAllServicesAndCharacteristicsForDevice.mockResolvedValue({});
    manager.readCharacteristicForDevice.mockResolvedValue({ value: null });
    const connection = await createBlePlxTransport().connect('bike-1');
    await expect(connection.read('1826', '2acc')).rejects.toThrow();
  });
});

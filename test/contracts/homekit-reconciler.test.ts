import type { AnyDeviceEvent, Device, DeviceManifest } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';

import type { CompleteDeviceSnapshot } from '../../src/device/snapshot.js';
import {
  HomeKitReconciler,
  type HomeKitDiagnostic,
  type HomeKitEventTrace,
  type HomeKitRegistryListener,
  type HomeKitRegistrySource,
  type HomeKitRegistryView,
} from '../../src/homekit/reconciler.js';

function contactManifest(serial: string, name = 'Synthetic contact tracer'): DeviceManifest {
  return {
    sn: serial,
    name,
    modelName: 'Synthetic contact sensor',
    codec: 'unknown',
    source: 'security',
    bound: true,
    capabilities: ['contact'],
    details: [
      {
        capability: 'contact',
        accessor: 'contact',
        reads: [
          {
            accessor: 'open',
            property: 'synthetic_contact_open',
            type: 'bool',
            writable: false,
          },
        ],
        actions: [],
        undescribedActions: [],
        events: ['contactState'],
      },
    ],
  };
}

function identityOnlyManifest(serial: string): DeviceManifest {
  return {
    sn: serial,
    name: 'Synthetic identity-only device',
    modelName: 'Synthetic dashboard device',
    codec: 'unknown',
    source: 'clean',
    bound: true,
    capabilities: [],
    details: [],
  };
}

function snapshot(...devices: DeviceManifest[]): CompleteDeviceSnapshot {
  return { version: 1, complete: true, devices };
}

function contactDevice(open: boolean, infoName = 'Synthetic contact tracer'): Device {
  return {
    contact: () => ({ open }),
    info: () => ({
      manufacturer: 'eufy',
      model: 'T0000',
      serialNumber: 'synthetic-contact',
      name: infoName,
      firmwareVersion: '1.2.3',
      hardwareVersion: '4.5',
    }),
  } as unknown as Device;
}

class RegistrySource implements HomeKitRegistrySource {
  private listener?: HomeKitRegistryListener;
  private eventListener?: (event: AnyDeviceEvent) => void;
  private current?: HomeKitRegistryView;

  currentRegistry(): HomeKitRegistryView | undefined {
    return this.current;
  }

  subscribeRegistry(listener: HomeKitRegistryListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
      }
    };
  }

  subscribeEvents(listener: (event: AnyDeviceEvent) => void): () => void {
    this.eventListener = listener;
    return () => {
      if (this.eventListener === listener) {
        this.eventListener = undefined;
      }
    };
  }

  publish(view: HomeKitRegistryView): void {
    this.current = view;
    this.listener?.(view);
  }

  publishEvent(event: AnyDeviceEvent): void {
    this.eventListener?.(event);
  }
}

function registryView(
  version: number,
  devices: ReadonlyMap<string, Device>,
  completeSnapshot: CompleteDeviceSnapshot,
): HomeKitRegistryView {
  return {
    version,
    generation: 'synthetic-generation',
    registry: devices,
    snapshot: completeSnapshot,
  };
}

function recordingApi() {
  const uuidInputs: string[] = [];
  const registerPlatformAccessories = vi.fn();
  const updatePlatformAccessories = vi.fn();
  const unregisterPlatformAccessories = vi.fn();
  return {
    uuidInputs,
    registerPlatformAccessories,
    updatePlatformAccessories,
    unregisterPlatformAccessories,
    api: {
      hap: {
        Service,
        Characteristic,
        HAPStatus,
        HapStatusError: class extends Error {},
      },
      generateUuid(input: string): string {
        uuidInputs.push(input);
        return uuid.generate(input);
      },
      createAccessory(name: string, accessoryUuid: string): PlatformAccessory {
        const accessory = new Accessory(name, accessoryUuid) as Accessory & {
          context: Record<string, unknown>;
          updateDisplayName(nextName: string): void;
        };
        accessory.context = {};
        accessory.updateDisplayName = (nextName): void => {
          accessory.displayName = nextName;
        };
        return accessory as unknown as PlatformAccessory;
      },
      register: registerPlatformAccessories,
      update: updatePlatformAccessories,
      unregister: unregisterPlatformAccessories,
    },
  };
}

describe('HomeKit registry reconciliation', () => {
  it('creates and updates one serial-based contact accessory with stable semantic services', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: HomeKitDiagnostic[] = [];
    const traces: HomeKitEventTrace[] = [];
    const reconciler = new HomeKitReconciler(
      source,
      recording.api,
      (diagnostic) => diagnostics.push(diagnostic),
      [],
      (trace) => traces.push(trace),
    );
    reconciler.start();

    const serial = 'synthetic-contact';
    source.publish(registryView(1, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));

    expect(recording.uuidInputs).toEqual([`d1_${serial}`]);
    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    expect(accessory.displayName).toBe('Synthetic contact tracer');
    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).toBeDefined();
    const information = accessory.getService(Service.AccessoryInformation)!;
    expect(information.getCharacteristic(Characteristic.Manufacturer).value).toBe('eufy');
    expect(information.getCharacteristic(Characteristic.Model).value).toBe('T0000');
    expect(information.getCharacteristic(Characteristic.SerialNumber).value).toBe('synthetic-contact');
    expect(information.getCharacteristic(Characteristic.Name).value).toBe('Synthetic contact tracer');
    expect(information.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('1.2.3');
    expect(information.getCharacteristic(Characteristic.HardwareRevision).value).toBe('4.5');

    source.publishEvent({ eventName: 'contactState', deviceSn: serial, stationSn: 'routing-only', open: true });
    expect(
      accessory
        .getServiceById(Service.ContactSensor, 'contact.sensor')
        ?.getCharacteristic(Characteristic.ContactSensorState).value,
    ).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(traces).toEqual([
      {
        adapter: 'contact.sensor',
        event: 'contact-state',
        observation: 'valid',
      },
    ]);
    expect(JSON.stringify(traces)).not.toContain(serial);

    source.publish(
      registryView(
        2,
        new Map([[serial, contactDevice(true, 'Renamed contact tracer')]]),
        snapshot(contactManifest(serial, 'Renamed contact tracer')),
      ),
    );

    expect(recording.uuidInputs).toEqual([`d1_${serial}`, `d1_${serial}`]);
    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    expect(recording.updatePlatformAccessories).toHaveBeenCalledWith([accessory]);
    expect(accessory.displayName).toBe('Renamed contact tracer');
    expect(accessory.services.filter((service) => service.UUID === Service.ContactSensor.UUID)).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'recognized-device-not-represented')).toEqual([]);
  });

  it('keeps devices without primary-purpose members dashboard-only with redacted diagnostics', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: HomeKitDiagnostic[] = [];
    new HomeKitReconciler(source, recording.api, (diagnostic) => diagnostics.push(diagnostic)).start();

    const serial = 'synthetic-dashboard-only';
    source.publish(
      registryView(
        1,
        new Map([[serial, { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device]]),
        snapshot(identityOnlyManifest(serial)),
      ),
    );

    expect(recording.uuidInputs).toEqual([]);
    expect(recording.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      {
        code: 'recognized-device-not-represented',
        active: true,
        reason: 'no-primary-purpose-member',
        affectedDeviceCount: 1,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(serial);

    const secondSerial = 'synthetic-dashboard-only-second';
    const secondManifest = identityOnlyManifest(secondSerial);
    source.publish(
      registryView(
        2,
        new Map([
          [serial, { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device],
          [secondSerial, { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device],
        ]),
        snapshot(identityOnlyManifest(serial), secondManifest),
      ),
    );
    expect(diagnostics.at(-1)).toMatchObject({ active: true, affectedDeviceCount: 2 });

    source.publish(
      registryView(
        3,
        new Map([[secondSerial, { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device]]),
        snapshot(secondManifest),
      ),
    );
    expect(diagnostics.at(-1)).toMatchObject({ active: true, affectedDeviceCount: 1 });

    source.publish(registryView(4, new Map(), snapshot()));
    expect(diagnostics.at(-1)).toEqual({
      code: 'recognized-device-not-represented',
      active: false,
      reason: 'recovered',
      affectedDeviceCount: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secondSerial);
  });

  it.each([
    ['non-boolean', { type: 'string', writable: false }],
    ['writable', { type: 'bool', writable: true }],
  ])('does not admit contact evidence that is %s', (_case, evidence) => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const manifest = contactManifest('synthetic-near-miss');
    Object.assign(manifest.details[0]!.reads[0]!, evidence);
    new HomeKitReconciler(source, recording.api, vi.fn()).start();

    source.publish(registryView(1, new Map([[manifest.sn, contactDevice(false)]]), snapshot(manifest)));

    expect(recording.registerPlatformAccessories).not.toHaveBeenCalled();
  });

  it('withdraws a historically owned cached accessory only from a later complete snapshot', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const serial = 'synthetic-cached-contact';
    const cached = recording.api.createAccessory('Cached contact', uuid.generate(`d1_${serial}`));
    cached.context.device = { uniqueId: serial, displayName: 'Legacy cached contact', type: 1 };
    new HomeKitReconciler(source, recording.api, vi.fn(), [cached]).start();

    expect(recording.unregisterPlatformAccessories).not.toHaveBeenCalled();
    source.publish(registryView(1, new Map(), snapshot()));

    expect(recording.unregisterPlatformAccessories).toHaveBeenCalledWith([cached]);
  });

  it('clears adapter diagnostics when a complete snapshot withdraws the device', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: HomeKitDiagnostic[] = [];
    const serial = 'synthetic-faulted-contact';
    new HomeKitReconciler(source, recording.api, (diagnostic) => diagnostics.push(diagnostic)).start();
    source.publish(registryView(1, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));

    source.publishEvent({
      eventName: 'contactState',
      deviceSn: serial,
      open: 'malformed',
    } as unknown as AnyDeviceEvent);
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'invalid-contact-observation',
      active: true,
      affectedDeviceCount: 1,
    });

    const diagnosticCount = diagnostics.length;
    source.publish(registryView(2, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));
    expect(diagnostics).toHaveLength(diagnosticCount);

    source.publish(registryView(3, new Map(), snapshot()));
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'invalid-contact-observation',
      active: false,
      reason: 'recovered',
      affectedDeviceCount: 0,
    });
  });

  it('clears an unavailable primary adapter diagnostic after complete capability withdrawal', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: HomeKitDiagnostic[] = [];
    const serial = 'synthetic-unavailable-contact';
    new HomeKitReconciler(source, recording.api, (diagnostic) => diagnostics.push(diagnostic)).start();
    source.publish(registryView(1, new Map([[serial, {} as Device]]), snapshot(contactManifest(serial))));

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'contact-capability-unavailable', active: true, affectedDeviceCount: 1 }),
    );
    const withdrawnManifest = identityOnlyManifest(serial);
    source.publish(registryView(2, new Map([[serial, {} as Device]]), snapshot(withdrawnManifest)));

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'contact-capability-unavailable',
        active: false,
        reason: 'recovered',
        affectedDeviceCount: 0,
      }),
    );
  });
});

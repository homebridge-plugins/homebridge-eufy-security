import type { AnyDeviceEvent, Device, DeviceManifest } from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function batteryManifest(serial: string, primary = false): DeviceManifest {
  const manifest = primary ? contactManifest(serial) : identityOnlyManifest(serial);
  manifest.capabilities.push('battery');
  manifest.details.push({
    capability: 'battery',
    accessor: 'battery',
    reads: [
      { accessor: 'level', property: 'synthetic_battery_level', type: 'number', writable: false },
      { accessor: 'charging', property: 'synthetic_battery_charging', type: 'bool', writable: false },
    ],
    actions: [],
    undescribedActions: [],
    events: ['batteryLevel', 'batteryAlert'],
  });
  return manifest;
}

function sirenManifest(serial: string): DeviceManifest {
  return {
    sn: serial,
    name: 'Synthetic indoor siren',
    modelName: 'Synthetic siren',
    codec: 'unknown',
    source: 'security',
    bound: true,
    capabilities: ['siren'],
    details: [
      {
        capability: 'siren',
        accessor: 'siren',
        reads: [
          {
            accessor: 'active',
            property: 'synthetic_siren_active',
            type: 'bool',
            writable: false,
          },
        ],
        actions: [
          { name: 'test', form: 'momentary' },
          { name: 'stop', form: 'momentary' },
        ],
        undescribedActions: [],
        events: [],
      },
    ],
  };
}

function smartLightManifest(serial: string): DeviceManifest {
  return {
    sn: serial,
    name: 'Synthetic smart light',
    modelName: 'Synthetic Life light',
    codec: 'light',
    source: 'life',
    bound: true,
    capabilities: ['smart_light'],
    details: [
      {
        capability: 'smart_light',
        accessor: 'smartLight',
        reads: [
          { accessor: 'power', property: 'synthetic_light_power', type: 'bool', writable: true },
          { accessor: 'brightness', property: 'synthetic_light_brightness', type: 'number', writable: true },
        ],
        actions: [
          { name: 'set', form: 'stateful', reflects: 'power' },
          { name: 'setBrightness', form: 'stateful', reflects: 'brightness' },
          { name: 'setColor', form: 'momentary' },
        ],
        undescribedActions: [],
        events: ['smartLightState'],
      },
    ],
  };
}

function contactSmartLightManifest(serial: string): DeviceManifest {
  const manifest = smartLightManifest(serial);
  const contact = contactManifest(serial);
  manifest.capabilities.push(...contact.capabilities);
  manifest.details.push(...contact.details);
  return manifest;
}

function eventManifest(
  serial: string,
  capability: 'motion' | 'person_detection' | 'doorbell',
  events: string[],
): DeviceManifest {
  return {
    sn: serial,
    name: 'Synthetic event source',
    modelName: 'Synthetic event device',
    codec: 'unknown',
    source: 'security',
    bound: true,
    capabilities: [capability],
    details: [
      {
        capability,
        accessor: capability,
        reads: [],
        actions: [],
        undescribedActions: [],
        events,
      },
    ],
  };
}

function snapshot(...devices: DeviceManifest[]): CompleteDeviceSnapshot {
  return { version: 1, complete: true, devices };
}

function contactDevice(open: unknown, infoName = 'Synthetic contact tracer'): Device {
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

function batteryContactDevice(open: boolean, level: number): Device {
  return {
    ...contactDevice(open),
    battery: () => ({ level, charging: false }),
  } as unknown as Device;
}

function sirenDevice(active = false): Device {
  return {
    siren: () => ({ active, test: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }),
  } as unknown as Device;
}

function smartLightDevice(power = false, brightness = 50): Device {
  return {
    smartLight: () => ({
      power,
      brightness,
      set: vi.fn(async () => undefined),
      setBrightness: vi.fn(async () => undefined),
      setColor: vi.fn(async () => undefined),
    }),
  } as unknown as Device;
}

function contactSmartLightDevice(open = false, power = false, brightness = 50): Device {
  return {
    ...contactDevice(open),
    ...smartLightDevice(power, brightness),
  } as Device;
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
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const migrationFixture = JSON.parse(readFileSync(`${repository}/test/fixtures/v4-migration.json`, 'utf8')) as {
    cachedAccessory: {
      context: PlatformAccessory['context'];
      platform: string;
      plugin: string;
      uuid: string;
      uuidInput: string;
    };
  };

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

  it('enriches a represented device with battery evidence and routes later low-state evidence', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const traces: HomeKitEventTrace[] = [];
    new HomeKitReconciler(source, recording.api, vi.fn(), [], (trace) => traces.push(trace)).start();
    const serial = 'synthetic-battery-contact';

    source.publish(
      registryView(1, new Map([[serial, batteryContactDevice(false, 75)]]), snapshot(batteryManifest(serial, true))),
    );

    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    const battery = accessory.getServiceById(Service.Battery, 'battery.status')!;
    expect(battery).toBeDefined();

    source.publishEvent({ eventName: 'batteryAlert', deviceSn: serial, state: 'low' });
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    source.publishEvent({ eventName: 'batteryLevel', deviceSn: serial, to: '30' });
    expect(battery.getCharacteristic(Characteristic.BatteryLevel).value).toBe(30);
    expect(battery.getCharacteristic(Characteristic.StatusLowBattery).value).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    expect(traces.map(({ adapter, event }) => ({ adapter, event }))).toEqual([
      { adapter: 'battery.status', event: 'battery-alert' },
      { adapter: 'battery.status', event: 'battery-level' },
    ]);

    source.publish(registryView(2, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));
    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).toBeDefined();
    expect(accessory.getServiceById(Service.Battery, 'battery.status')).toBeUndefined();
  });

  it('keeps battery-only devices dashboard-only', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: HomeKitDiagnostic[] = [];
    new HomeKitReconciler(source, recording.api, (diagnostic) => diagnostics.push(diagnostic)).start();
    const serial = 'synthetic-battery-only';

    source.publish(
      registryView(1, new Map([[serial, batteryContactDevice(false, 75)]]), snapshot(batteryManifest(serial))),
    );

    expect(recording.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      code: 'recognized-device-not-represented',
      active: true,
      reason: 'no-primary-purpose-member',
    });
  });

  it('keeps an admitted device dashboard-only when its representation preference is disabled', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const serial = 'synthetic-disabled-representation';
    new HomeKitReconciler(source, recording.api, vi.fn(), [], undefined, {
      [serial]: { represented: false },
    }).start();

    source.publish(registryView(1, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));

    expect(recording.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(recording.uuidInputs).toEqual([]);
  });

  it.each([
    ['person_detection', ['personDetected'], Service.MotionSensor, 'motion.sensor'],
    ['doorbell', ['doorbellPress'], Service.Doorbell, 'doorbell.press'],
  ] as const)(
    'admits one evidenced %s event without requiring unrelated events',
    (capability, events, service, key) => {
      const source = new RegistrySource();
      const recording = recordingApi();
      new HomeKitReconciler(source, recording.api, vi.fn()).start();
      const serial = `synthetic-${capability}`;

      source.publish(
        registryView(1, new Map([[serial, {} as Device]]), snapshot(eventManifest(serial, capability, [...events]))),
      );

      expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
      const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
      expect(accessory.getServiceById(service, key)).toBeDefined();
    },
  );

  it('represents a siren only with active, test, and stop evidence', () => {
    const serial = 'synthetic-siren';
    const source = new RegistrySource();
    const recording = recordingApi();
    new HomeKitReconciler(source, recording.api, vi.fn()).start();

    source.publish(registryView(1, new Map([[serial, sirenDevice()]]), snapshot(sirenManifest(serial))));

    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    expect(accessory.getServiceById(Service.Switch, 'siren.test')).toBeDefined();

    for (const missing of ['active', 'test', 'stop'] as const) {
      const nearMiss = sirenManifest(`synthetic-siren-without-${missing}`);
      const detail = nearMiss.details[0]!;
      if (missing === 'active') {
        detail.reads = [];
      } else {
        detail.actions = detail.actions.filter(({ name }) => name !== missing);
      }
      const nearMissSource = new RegistrySource();
      const nearMissRecording = recordingApi();
      new HomeKitReconciler(nearMissSource, nearMissRecording.api, vi.fn()).start();
      nearMissSource.publish(registryView(1, new Map([[nearMiss.sn, sirenDevice()]]), snapshot(nearMiss)));
      expect(nearMissRecording.registerPlatformAccessories, missing).not.toHaveBeenCalled();
    }
  });

  it('creates a serial-based smart-light accessory and withdraws it only from a complete snapshot', () => {
    const serial = 'synthetic-smart-light';
    const source = new RegistrySource();
    const recording = recordingApi();
    new HomeKitReconciler(source, recording.api, vi.fn()).start();

    source.publish(registryView(1, new Map([[serial, smartLightDevice()]]), snapshot(smartLightManifest(serial))));

    expect(recording.uuidInputs).toEqual([`d1_${serial}`]);
    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    const service = accessory.getServiceById(Service.Lightbulb, 'smart-light.lightbulb')!;
    expect(service).toBeDefined();
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(true);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(true);
    source.publishEvent({ eventName: 'smartLightState', deviceSn: serial, power: true });
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    source.publish(registryView(2, new Map(), snapshot()));
    expect(recording.unregisterPlatformAccessories).toHaveBeenCalledWith([accessory]);
  });

  it('withdraws and recreates only the affected service while another primary member remains', () => {
    const serial = 'synthetic-contact-light';
    const source = new RegistrySource();
    const recording = recordingApi();
    new HomeKitReconciler(source, recording.api, vi.fn()).start();

    source.publish(
      registryView(1, new Map([[serial, contactSmartLightDevice()]]), snapshot(contactSmartLightManifest(serial))),
    );
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    const contact = accessory.getServiceById(Service.ContactSensor, 'contact.sensor')!;
    const light = accessory.getServiceById(Service.Lightbulb, 'smart-light.lightbulb')!;

    source.publish(
      registryView(2, new Map([[serial, smartLightDevice()]]), snapshot(contactSmartLightManifest(serial))),
    );

    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).toBe(contact);
    expect(accessory.getServiceById(Service.Lightbulb, 'smart-light.lightbulb')).toBe(light);
    expect(recording.unregisterPlatformAccessories).not.toHaveBeenCalled();

    source.publish(registryView(3, new Map([[serial, smartLightDevice()]]), snapshot(smartLightManifest(serial))));

    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).toBeUndefined();
    expect(accessory.getServiceById(Service.Lightbulb, 'smart-light.lightbulb')).toBe(light);
    expect(recording.unregisterPlatformAccessories).not.toHaveBeenCalled();

    source.publish(
      registryView(4, new Map([[serial, contactSmartLightDevice(true)]]), snapshot(contactSmartLightManifest(serial))),
    );

    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).toBeDefined();
    expect(accessory.getServiceById(Service.ContactSensor, 'contact.sensor')).not.toBe(contact);
    expect(accessory.getServiceById(Service.Lightbulb, 'smart-light.lightbulb')).toBe(light);
    expect(recording.registerPlatformAccessories).toHaveBeenCalledOnce();
    expect(recording.unregisterPlatformAccessories).not.toHaveBeenCalled();
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
    expect(diagnostics.at(-1)).toMatchObject({ active: true });

    source.publish(
      registryView(
        3,
        new Map([[secondSerial, { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device]]),
        snapshot(secondManifest),
      ),
    );
    expect(diagnostics.at(-1)).toMatchObject({ active: true });

    source.publish(registryView(4, new Map(), snapshot()));
    expect(diagnostics.at(-1)).toEqual({
      code: 'recognized-device-not-represented',
      active: false,
      reason: 'recovered',
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secondSerial);
  });

  it('selects a representation reason independently from registry order', () => {
    const evaluate = (order: readonly ['identity', 'unavailable'] | readonly ['unavailable', 'identity']): string => {
      const source = new RegistrySource();
      const recording = recordingApi();
      const diagnostics: HomeKitDiagnostic[] = [];
      const identitySerial = 'synthetic-identity-only';
      const unavailableSerial = 'synthetic-unavailable-primary';
      const devices = {
        identity: [
          identitySerial,
          { info: () => ({ manufacturer: 'eufy' }) } as unknown as Device,
          identityOnlyManifest(identitySerial),
        ] as const,
        unavailable: [unavailableSerial, {} as Device, contactManifest(unavailableSerial)] as const,
      };
      new HomeKitReconciler(source, recording.api, (diagnostic) => diagnostics.push(diagnostic)).start();
      source.publish(
        registryView(
          1,
          new Map(order.map((key) => [devices[key][0], devices[key][1]])),
          snapshot(...order.map((key) => devices[key][2])),
        ),
      );
      return diagnostics.filter(({ code }) => code === 'recognized-device-not-represented').at(-1)!.reason;
    };

    expect(evaluate(['identity', 'unavailable'])).toBe('no-primary-purpose-member');
    expect(evaluate(['unavailable', 'identity'])).toBe('no-primary-purpose-member');
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

  it('upgrades one matched V4 cached accessory without duplicate or orphaned ownership', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const fixture = migrationFixture.cachedAccessory;
    const serial = fixture.context.device.uniqueId as string;
    const cached = recording.api.createAccessory('Legacy contact', fixture.uuid);
    cached.context = structuredClone(fixture.context);
    new HomeKitReconciler(source, recording.api, vi.fn(), [cached]).start();

    source.publish(registryView(1, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));

    expect(fixture.plugin).toBe('@homebridge-plugins/homebridge-eufy-security');
    expect(fixture.platform).toBe('EufySecurity');
    expect(fixture.uuidInput).toBe(`d1_${serial}`);
    expect(uuid.generate(fixture.uuidInput)).toBe(fixture.uuid);
    expect(recording.registerPlatformAccessories).not.toHaveBeenCalled();
    expect(recording.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(recording.updatePlatformAccessories).toHaveBeenCalledExactlyOnceWith([cached]);
    expect(cached.context).toMatchObject({
      device: fixture.context.device,
      homebridgeEufy: { version: 1, serial },
    });
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
    });

    const diagnosticCount = diagnostics.length;
    source.publish(registryView(2, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));
    expect(diagnostics).toHaveLength(diagnosticCount);

    source.publish(registryView(3, new Map(), snapshot()));
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'invalid-contact-observation',
      active: false,
      reason: 'recovered',
    });
  });

  it('selects an aggregate adapter reason independently from report order', async () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const diagnostics: Array<{ diagnostic: HomeKitDiagnostic; affectedDeviceIds: readonly string[] }> = [];
    const malformedSerial = 'synthetic-malformed-contact';
    const missingSerial = 'synthetic-missing-contact';
    new HomeKitReconciler(source, recording.api, (diagnostic, affectedDeviceIds) =>
      diagnostics.push({ diagnostic, affectedDeviceIds }),
    ).start();
    source.publish(
      registryView(
        1,
        new Map([
          [malformedSerial, contactDevice(false, 'Malformed contact')],
          [missingSerial, contactDevice(undefined, 'Missing contact')],
        ]),
        snapshot(contactManifest(malformedSerial), contactManifest(missingSerial)),
      ),
    );

    source.publishEvent({
      eventName: 'contactState',
      deviceSn: malformedSerial,
      open: 'malformed',
    } as unknown as AnyDeviceEvent);
    const accessories = recording.registerPlatformAccessories.mock.calls.flatMap(
      ([registered]) => registered as PlatformAccessory[],
    );
    const missingAccessory = accessories[1]!;
    await expect(
      missingAccessory
        .getServiceById(Service.ContactSensor, 'contact.sensor')!
        .getCharacteristic(Characteristic.ContactSensorState)
        .handleGetRequest(),
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    expect(diagnostics.at(-1)).toMatchObject({
      diagnostic: { code: 'invalid-contact-observation', reason: 'malformed', active: true },
      affectedDeviceIds: expect.arrayContaining([malformedSerial, missingSerial]),
    });

    source.publishEvent({ eventName: 'contactState', deviceSn: malformedSerial, open: false });
    expect(diagnostics.at(-1)).toMatchObject({
      diagnostic: { code: 'invalid-contact-observation', reason: 'missing', active: true },
      affectedDeviceIds: [missingSerial],
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
      expect.objectContaining({ code: 'contact-capability-unavailable', active: true }),
    );
    const withdrawnManifest = identityOnlyManifest(serial);
    source.publish(registryView(2, new Map([[serial, {} as Device]]), snapshot(withdrawnManifest)));

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'contact-capability-unavailable',
        active: false,
        reason: 'recovered',
      }),
    );
  });

  it('reattaches event adapters when restarted against the retained registry publication', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const serial = 'synthetic-restarted-contact';
    const reconciler = new HomeKitReconciler(source, recording.api, vi.fn());
    reconciler.start();
    source.publish(registryView(1, new Map([[serial, contactDevice(false)]]), snapshot(contactManifest(serial))));
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    const state = accessory
      .getServiceById(Service.ContactSensor, 'contact.sensor')!
      .getCharacteristic(Characteristic.ContactSensorState);

    reconciler.stop();
    reconciler.start();
    source.publishEvent({ eventName: 'contactState', deviceSn: serial, open: true });

    const reboundState = accessory
      .getServiceById(Service.ContactSensor, 'contact.sensor')!
      .getCharacteristic(Characteristic.ContactSensorState);
    expect(reboundState).not.toBe(state);
    expect(reboundState.value).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  });

  it.each([
    ['active', 0],
    ['expired', 10_000],
  ] as const)('removes an %s motion hold when complete evidence withdraws motion', (_state, elapsedMs) => {
    vi.useFakeTimers();
    const source = new RegistrySource();
    const recording = recordingApi();
    const serial = 'synthetic-withdrawn-motion';
    const doorbell = eventManifest(serial, 'doorbell', ['doorbellPress']);
    const withMotion = structuredClone(doorbell);
    withMotion.capabilities.push('person_detection');
    withMotion.details.push(eventManifest(serial, 'person_detection', ['personDetected']).details[0]!);
    const reconciler = new HomeKitReconciler(source, recording.api, vi.fn());
    reconciler.start();
    source.publish(registryView(1, new Map([[serial, {} as Device]]), snapshot(withMotion)));
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    const state = accessory
      .getServiceById(Service.MotionSensor, 'motion.sensor')!
      .getCharacteristic(Characteristic.MotionDetected);
    source.publishEvent({ eventName: 'personDetected', deviceSn: serial });
    expect(state.value).toBe(true);
    vi.advanceTimersByTime(elapsedMs);

    source.publish(registryView(2, new Map([[serial, {} as Device]]), snapshot(doorbell)));

    expect(state.value).toBe(false);
    expect(accessory.getServiceById(Service.MotionSensor, 'motion.sensor')).toBeUndefined();
    reconciler.stop();
    vi.useRealTimers();
  });

  it('removes the doorbell service when complete evidence withdraws presses', () => {
    const source = new RegistrySource();
    const recording = recordingApi();
    const serial = 'synthetic-withdrawn-doorbell';
    const motion = eventManifest(serial, 'person_detection', ['personDetected']);
    const withDoorbell = structuredClone(motion);
    withDoorbell.capabilities.push('doorbell');
    withDoorbell.details.push(eventManifest(serial, 'doorbell', ['doorbellPress']).details[0]!);
    const reconciler = new HomeKitReconciler(source, recording.api, vi.fn());
    reconciler.start();
    source.publish(registryView(1, new Map([[serial, {} as Device]]), snapshot(withDoorbell)));
    const accessory = recording.registerPlatformAccessories.mock.calls[0]?.[0][0] as PlatformAccessory;
    expect(accessory.getServiceById(Service.Doorbell, 'doorbell.press')).toBeDefined();

    source.publish(registryView(2, new Map([[serial, {} as Device]]), snapshot(motion)));

    expect(accessory.getServiceById(Service.Doorbell, 'doorbell.press')).toBeUndefined();
    reconciler.stop();
  });
});

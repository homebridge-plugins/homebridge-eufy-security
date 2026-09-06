import {
  CapabilityNotSupportedError,
  unreflectedMembers,
  type AudioActions,
  type CameraActions,
  type LightActions,
} from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import type { AdapterDiagnostic } from '../../src/homekit/adapter.js';
import {
  CAMERA_CONTROLS_ADAPTER,
  CAMERA_ENABLED_SERVICE_KEY,
  CAMERA_LIGHT_SERVICE_KEY,
  CAMERA_MICROPHONE_SERVICE_KEY,
  CAMERA_SPEAKER_SERVICE_KEY,
  CAMERA_STATUS_LED_SERVICE_KEY,
  type CameraControlsSdkDevice,
} from '../../src/homekit/adapters/camera-controls.js';

const HAP = { Service, Characteristic, HAPStatus, HapStatusError };
/**
 * The flat property name this synthetic manifest announces the camera's power under.
 *
 * Deliberately not `enabled`: the SDK's generic announcement names the property while the coverage row and
 * the requirement name the accessor, so a test reusing one string for both would pass against a bundle that
 * had simply hardcoded the accessor.
 */
const ANNOUNCED_ENABLED_PROPERTY = 'synthetic_camera_enabled';
const EVIDENCE = new Map(CAMERA_CONTROLS_ADAPTER.coverage.map((id) => [id, requirement(id)]));

function requirement(id: string) {
  const [capability, member, suffix] = id.split('.');
  const type = member === 'volume' || member === 'brightness' ? 'number' : 'bool';
  return suffix === 'read'
    ? {
        id,
        kind: 'read' as const,
        type: type as 'bool' | 'number',
        writable: true,
        ...(id === 'camera.enabled.read' ? { property: ANNOUNCED_ENABLED_PROPERTY } : {}),
      }
    : { id, kind: 'persistent-operation' as const };
}

/** One generic SDK announcement that the camera's own power property moved. */
function enablementAnnounced(property = ANNOUNCED_ENABLED_PROPERTY) {
  return { eventName: 'propertyChanged', deviceSn: 'T8000P0000000000', property } as never;
}

/**
 * The evidence that admits writing the camera's power, which the bundle gates the switch on but does not
 * carry a coverage row for: the operation is declared once, by the camera streaming bundle.
 */
function writableEnablement(): typeof EVIDENCE {
  return new Map([
    ...EVIDENCE,
    ['camera.enabled.persistent-operation', requirement('camera.enabled.persistent-operation')],
  ]);
}

function accessory(): PlatformAccessory {
  return new Accessory('Synthetic camera', uuid.generate('synthetic-camera-controls')) as unknown as PlatformAccessory;
}

function device(
  camera: Partial<CameraActions>,
  light?: Partial<LightActions>,
  audio?: Partial<AudioActions>,
): CameraControlsSdkDevice {
  return {
    camera: () => camera as CameraActions,
    ...(light ? { light: () => light as LightActions } : {}),
    ...(audio ? { audio: () => audio as AudioActions } : {}),
  };
}

function attach(
  target: PlatformAccessory,
  sdkDevice: CameraControlsSdkDevice,
  evidence = EVIDENCE,
  diagnose: (diagnostic: AdapterDiagnostic) => void = vi.fn(),
) {
  return CAMERA_CONTROLS_ADAPTER.attach({
    device: sdkDevice as never,
    evidence,
    accessory: target,
    hap: HAP,
    diagnose,
    observed: vi.fn(),
    persist: vi.fn(),
  });
}

describe('camera controls capability adapter', () => {
  it('keeps the physical camera light distinct from the enabled state and from mute', async () => {
    const target = accessory();
    attach(
      target,
      device(
        { enabled: true },
        { isOn: true, brightness: 45, set: vi.fn(), setBrightness: vi.fn() },
        {
          microphone: true,
          setMicrophone: vi.fn(),
        },
      ),
    );

    const physicalLight = target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!;
    const enabled = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!;
    const microphone = target.getServiceById(Service.Microphone, CAMERA_MICROPHONE_SERVICE_KEY)!;

    expect(physicalLight).toBeDefined();
    expect(physicalLight).not.toBe(enabled);
    expect(physicalLight).not.toBe(microphone);
    await expect(physicalLight.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true);
    await expect(physicalLight.getCharacteristic(Characteristic.Brightness).handleGetRequest()).resolves.toBe(45);
    await expect(enabled.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true);
  });

  it('withdraws the indicator LED switch an earlier version published for this camera', () => {
    const target = accessory();
    target.addService(Service.Switch, 'Status LED', CAMERA_STATUS_LED_SERVICE_KEY);

    attach(target, device({ enabled: true }));

    expect(target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)).toBeUndefined();
  });

  it('maps enabled state and audio controls without conflating enabled switches with mute', async () => {
    const target = accessory();
    const setMicrophone = vi.fn(async () => undefined);
    const setSpeaker = vi.fn(async () => undefined);
    const setVolume = vi.fn(async () => undefined);
    attach(
      target,
      device({ enabled: false }, undefined, {
        microphone: true,
        speaker: false,
        volume: 65,
        setMicrophone,
        setSpeaker,
        setVolume,
      }),
    );

    const enabled = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!;
    const microphone = target.getServiceById(Service.Microphone, CAMERA_MICROPHONE_SERVICE_KEY)!;
    const speaker = target.getServiceById(Service.Speaker, CAMERA_SPEAKER_SERVICE_KEY)!;

    await expect(enabled.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(false);
    await expect(microphone.getCharacteristic(Characteristic.Mute).handleGetRequest()).resolves.toBe(false);
    await expect(speaker.getCharacteristic(Characteristic.Mute).handleGetRequest()).resolves.toBe(true);
    await expect(speaker.getCharacteristic(Characteristic.Volume).handleGetRequest()).resolves.toBe(65);

    await microphone.getCharacteristic(Characteristic.Mute).handleSetRequest(true);
    await speaker.getCharacteristic(Characteristic.Mute).handleSetRequest(false);
    await speaker.getCharacteristic(Characteristic.Volume).handleSetRequest(25);
    expect(setMicrophone).toHaveBeenCalledExactlyOnceWith(false);
    expect(setSpeaker).toHaveBeenCalledExactlyOnceWith(true);
    expect(setVolume).toHaveBeenCalledExactlyOnceWith(25);
  });

  it('omits optional controls whose evidence has the wrong semantic contract', () => {
    const target = accessory();
    const malformedEvidence = new Map(EVIDENCE);
    malformedEvidence.set('light.brightness.read', {
      id: 'light.brightness.read',
      kind: 'read',
      type: 'bool',
      writable: true,
    });

    attach(
      target,
      device({ enabled: true }, { isOn: false, brightness: 40, set: vi.fn(), setBrightness: vi.fn() }),
      malformedEvidence,
    );

    expect(
      target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!.testCharacteristic(Characteristic.Brightness),
    ).toBe(false);
  });

  it('faults malformed authoritative observations instead of borrowing another boolean member', async () => {
    const target = accessory();
    attach(
      target,
      device({ enabled: true }, { isOn: 'malformed' as never, brightness: 0, set: vi.fn(), setBrightness: vi.fn() }),
    );

    await expect(
      target
        .getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!
        .getCharacteristic(Characteristic.On)
        .handleGetRequest(),
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await expect(
      target
        .getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!
        .getCharacteristic(Characteristic.Brightness)
        .handleGetRequest(),
    ).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  it('faults evidenced controls whose typed SDK operations are unavailable', () => {
    const target = accessory();
    const diagnostics: AdapterDiagnostic[] = [];

    attach(target, device({ enabled: true }, { isOn: true, set: vi.fn() }));

    attach(target, device({ enabled: true }, { isOn: true }), EVIDENCE, (diagnostic) => diagnostics.push(diagnostic));

    expect(target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)).toBeUndefined();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'camera-controls-capability-unavailable',
        capability: 'light',
        member: 'isOn',
        active: true,
        reason: 'missing',
      }),
    );
  });

  it('bounds a camera control operation without retrying or replacing its authoritative observation', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const set = vi.fn(() => new Promise<void>(() => undefined));
    attach(target, device({ enabled: true }, { isOn: false, set }));
    const on = target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!.getCharacteristic(Characteristic.On);

    const write = expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(8_000);

    await write;
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    await expect(on.handleGetRequest()).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('blocks later writes after the SDK reports the evidenced operation unsupported', async () => {
    const target = accessory();
    const set = vi.fn(async () => {
      throw new CapabilityNotSupportedError('synthetic-camera', 'isOn');
    });
    attach(target, device({ enabled: true }, { isOn: false, set }));
    const on = target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!.getCharacteristic(Characteristic.On);

    await expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    attach(target, device({ enabled: true }, { isOn: false, set }));
    await expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(set).toHaveBeenCalledOnce();
  });

  it('switches the camera off and on again when HomeKit writes the enabled state', async () => {
    const target = accessory();
    const state = { enabled: true };
    const setEnabled = vi.fn(async (value: boolean) => {
      state.enabled = value;
    });
    attach(
      target,
      device({
        get enabled(): boolean {
          return state.enabled;
        },
        setEnabled,
      } as Partial<CameraActions>),
      writableEnablement(),
    );
    const on = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!.getCharacteristic(Characteristic.On);

    await on.handleSetRequest(false);
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(on.handleGetRequest()).resolves.toBe(false);

    await on.handleSetRequest(true);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    await expect(on.handleGetRequest()).resolves.toBe(true);
  });

  it('refuses an enabled write for a member the SDK declines to stand behind', async () => {
    const target = accessory();
    const setEnabled = vi.fn(async () => undefined);
    const diagnose = vi.fn();
    /**
     * `unreflectedMembers` reads a symbol-keyed statement only the SDK's own binding attaches, and no camera
     * family reports one today, so a proxy answering every symbol read is the only way to exercise a member
     * the SDK declines to stand behind.
     */
    const camera = new Proxy({ enabled: true, setEnabled } as Partial<CameraActions>, {
      get(inner, property, receiver) {
        return typeof property === 'symbol' ? Object.freeze(['enabled']) : Reflect.get(inner, property, receiver);
      },
    });
    expect(unreflectedMembers(camera as CameraActions)).toContain('enabled');

    attach(target, { camera: () => camera as CameraActions }, writableEnablement(), diagnose);
    const on = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!.getCharacteristic(Characteristic.On);

    await expect(on.handleSetRequest(false)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(
      setEnabled,
      'a reading that does not track its own setter leaves HomeKit unable to tell whether the write landed',
    ).not.toHaveBeenCalled();
  });

  it('announces no stale reading for an accepted enabled state the camera has not converged on', async () => {
    const target = accessory();
    const state = { enabled: true };
    const setEnabled = vi.fn(async () => undefined);
    attach(
      target,
      device({
        get enabled(): boolean {
          return state.enabled;
        },
        setEnabled,
      } as Partial<CameraActions>),
      writableEnablement(),
    );
    const on = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!.getCharacteristic(Characteristic.On);
    const announced: unknown[] = [];
    on.on('change', ({ newValue }) => announced.push(newValue));

    await on.handleSetRequest(false);
    await delay(0);

    expect(
      announced,
      'an acknowledgement is delivery and not convergence, so re-reading the camera then announces the value the user just replaced',
    ).toEqual([false]);
    expect(on.value).toBe(false);
  });

  it('refuses an enabled write it has no evidence or bound operation for, and reports each refusal', async () => {
    const cases = [
      { label: 'unevidenced', evidence: EVIDENCE, setEnabled: vi.fn(async () => undefined) },
      { label: 'unbound', evidence: writableEnablement(), setEnabled: undefined },
    ];

    for (const { label, evidence, setEnabled } of cases) {
      const target = accessory();
      const diagnose = vi.fn();
      attach(
        target,
        device({ enabled: true, ...(setEnabled ? { setEnabled } : {}) } as Partial<CameraActions>),
        evidence,
        diagnose,
      );
      const on = target
        .getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!
        .getCharacteristic(Characteristic.On);

      await expect(on.handleSetRequest(false), label).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
      expect(setEnabled ?? vi.fn(), label).not.toHaveBeenCalled();
      expect(diagnose, label).toHaveBeenCalledWith({
        code: 'camera-controls-capability-unavailable',
        capability: 'camera',
        member: 'enabled',
        active: true,
        reason: 'missing',
      });
    }
  });

  it('removes cached optional services when complete evidence withdraws their members', () => {
    const target = accessory();
    const sdkDevice = device({ enabled: true }, { isOn: true, brightness: 50, set: vi.fn(), setBrightness: vi.fn() });
    attach(target, sdkDevice);

    attach(target, sdkDevice, new Map([['camera.enabled.read', requirement('camera.enabled.read')]]));

    expect(target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)).toBeUndefined();
  });

  it('retains a late unsupported result across adapter replacement', async () => {
    const target = accessory();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<void>((_, reject) => {
      rejectOperation = reject;
    });
    const set = vi.fn(() => operation);
    const sdkDevice = device({ enabled: true }, { isOn: false, set });
    const first = attach(target, sdkDevice)!;
    const on = target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!.getCharacteristic(Characteristic.On);
    const pending = on.handleSetRequest(true);
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());

    attach(target, sdkDevice);
    first.detach?.();
    await expect(pending).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    rejectOperation(new CapabilityNotSupportedError('synthetic-camera', 'isOn'));
    await vi.waitFor(() => expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    expect(set).toHaveBeenCalledOnce();
  });

  it('announces the camera power to HomeKit when something else changed it', async () => {
    const target = accessory();
    const state = { enabled: true };
    const attached = attach(
      target,
      device({
        get enabled(): boolean {
          return state.enabled;
        },
      } as Partial<CameraActions>),
    );
    const on = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!.getCharacteristic(Characteristic.On);
    await on.handleGetRequest();
    const announced: unknown[] = [];
    on.on('change', ({ newValue }) => announced.push(newValue));

    state.enabled = false;
    const trace = attached!.event!(enablementAnnounced());

    expect(
      announced,
      'HomeKit reads only while the Home app is open, so a switch that never pushes shows the old state for good',
    ).toEqual([false]);
    expect(trace).toEqual({ event: 'camera-enabled-changed', observation: 'valid', announcedBy: 'poll' });

    attached!.event!(enablementAnnounced());
    expect(announced, 'a repeated announcement is not a change, so it is not a notification').toEqual([false]);

    state.enabled = true;
    expect(
      attached!.event!(enablementAnnounced('synthetic_camera_status_led')),
      'an announcement about another property of the same device is not this one moving',
    ).toBeUndefined();
    expect(announced).toEqual([false]);
  });

  it('leaves the announced switch alone when the reading faults, and says the reading was missing', () => {
    const target = accessory();
    const state = { faulting: false };
    const attached = attach(
      target,
      device({
        get enabled(): boolean {
          if (state.faulting) throw new Error('synthetic enablement read fault');
          return true;
        },
      } as Partial<CameraActions>),
    );
    const on = target.getServiceById(Service.Switch, CAMERA_ENABLED_SERVICE_KEY)!.getCharacteristic(Characteristic.On);
    on.updateValue(true);

    state.faulting = true;
    const trace = attached!.event!({ eventName: 'cameraEnabledChanged', deviceSn: 'T8000P0000000000' } as never);

    expect(on.value, 'a switch showing its last known state is honest; one showing a guess is not').toBe(true);
    expect(trace).toEqual({ event: 'camera-enabled-changed', observation: 'missing', announcedBy: 'write' });
  });

  it('claims no event that is not an enablement announcement', () => {
    const target = accessory();
    const attached = attach(target, device({ enabled: true }));

    expect(attached!.event!({ eventName: 'motion', deviceSn: 'T8000P0000000000' } as never)).toBeUndefined();
  });
});

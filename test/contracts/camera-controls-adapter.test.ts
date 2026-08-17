import {
  CapabilityNotSupportedError,
  type AudioActions,
  type CameraActions,
  type LightActions,
} from '@mega-yfue/eufy-sdk';
import { Accessory, Characteristic, HAPStatus, HapStatusError, Service, uuid } from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
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
const EVIDENCE = new Map(CAMERA_CONTROLS_ADAPTER.coverage.map(({ id }) => [id, requirement(id)]));

function requirement(id: string) {
  const [capability, member, suffix] = id.split('.');
  const type = member === 'volume' || member === 'brightness' ? 'number' : 'bool';
  return suffix === 'read'
    ? { id, kind: 'read' as const, type: type as 'bool' | 'number', writable: true }
    : { id, kind: 'persistent-operation' as const };
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
  it('keeps the physical camera light and unified status LED as separate authoritative services', async () => {
    const target = accessory();
    attach(
      target,
      device(
        { enabled: true, statusLed: false, setStatusLed: vi.fn() },
        { isOn: true, brightness: 45, set: vi.fn(), setBrightness: vi.fn() },
      ),
    );

    const physicalLight = target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!;
    const statusLed = target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!;

    expect(physicalLight).toBeDefined();
    expect(statusLed).toBeDefined();
    expect(physicalLight).not.toBe(statusLed);
    await expect(physicalLight.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true);
    await expect(physicalLight.getCharacteristic(Characteristic.Brightness).handleGetRequest()).resolves.toBe(45);
    await expect(statusLed.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(false);
  });

  it('maps enabled state and audio controls without conflating enabled switches with mute', async () => {
    const target = accessory();
    const setStatusLed = vi.fn(async () => undefined);
    const setMicrophone = vi.fn(async () => undefined);
    const setSpeaker = vi.fn(async () => undefined);
    const setVolume = vi.fn(async () => undefined);
    attach(
      target,
      device({ enabled: false, statusLed: true, setStatusLed }, undefined, {
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
    const statusLed = target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!;

    await expect(enabled.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(false);
    await expect(microphone.getCharacteristic(Characteristic.Mute).handleGetRequest()).resolves.toBe(false);
    await expect(speaker.getCharacteristic(Characteristic.Mute).handleGetRequest()).resolves.toBe(true);
    await expect(speaker.getCharacteristic(Characteristic.Volume).handleGetRequest()).resolves.toBe(65);

    await microphone.getCharacteristic(Characteristic.Mute).handleSetRequest(true);
    await speaker.getCharacteristic(Characteristic.Mute).handleSetRequest(false);
    await speaker.getCharacteristic(Characteristic.Volume).handleSetRequest(25);
    await statusLed.getCharacteristic(Characteristic.On).handleSetRequest(false);
    expect(setMicrophone).toHaveBeenCalledExactlyOnceWith(false);
    expect(setSpeaker).toHaveBeenCalledExactlyOnceWith(true);
    expect(setVolume).toHaveBeenCalledExactlyOnceWith(25);
    expect(setStatusLed).toHaveBeenCalledExactlyOnceWith(false);
    await expect(statusLed.getCharacteristic(Characteristic.On).handleGetRequest()).resolves.toBe(true);
  });

  it('omits optional controls whose evidence has the wrong semantic contract', () => {
    const target = accessory();
    const malformedEvidence = new Map(EVIDENCE);
    malformedEvidence.set('camera.statusLed.read', {
      id: 'camera.statusLed.read',
      kind: 'read',
      type: 'string',
      writable: true,
    });
    malformedEvidence.set('light.brightness.read', {
      id: 'light.brightness.read',
      kind: 'read',
      type: 'bool',
      writable: true,
    });

    attach(
      target,
      device(
        { enabled: true, statusLed: true, setStatusLed: vi.fn() },
        { isOn: false, brightness: 40, set: vi.fn(), setBrightness: vi.fn() },
      ),
      malformedEvidence,
    );

    expect(target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)).toBeUndefined();
    expect(
      target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)!.testCharacteristic(Characteristic.Brightness),
    ).toBe(false);
  });

  it('faults malformed authoritative observations instead of borrowing another boolean member', async () => {
    const target = accessory();
    attach(
      target,
      device(
        { enabled: true, statusLed: 'malformed' as never, setStatusLed: vi.fn() },
        { isOn: false, brightness: 0, set: vi.fn(), setBrightness: vi.fn() },
      ),
    );

    await expect(
      target
        .getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!
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

    attach(target, device({ enabled: true, statusLed: true, setStatusLed: vi.fn() }));

    attach(target, device({ enabled: true, statusLed: true }), EVIDENCE, (diagnostic) => diagnostics.push(diagnostic));

    expect(target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)).toBeUndefined();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'camera-controls-capability-unavailable',
        capability: 'camera',
        member: 'statusLed',
        active: true,
        reason: 'missing',
      }),
    );
  });

  it('bounds a camera control operation without retrying or replacing its authoritative observation', async () => {
    vi.useFakeTimers();
    const target = accessory();
    const setStatusLed = vi.fn(() => new Promise<void>(() => undefined));
    attach(target, device({ enabled: true, statusLed: false, setStatusLed }));
    const on = target
      .getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!
      .getCharacteristic(Characteristic.On);

    const write = expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await vi.advanceTimersByTimeAsync(8_000);

    await write;
    expect(setStatusLed).toHaveBeenCalledExactlyOnceWith(true);
    await expect(on.handleGetRequest()).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('blocks later writes after the SDK reports the evidenced operation unsupported', async () => {
    const target = accessory();
    const setStatusLed = vi.fn(async () => {
      throw new CapabilityNotSupportedError('synthetic-camera', 'statusLed');
    });
    attach(target, device({ enabled: true, statusLed: false, setStatusLed }));
    const on = target
      .getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!
      .getCharacteristic(Characteristic.On);

    await expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    attach(target, device({ enabled: true, statusLed: false, setStatusLed }));
    await expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(setStatusLed).toHaveBeenCalledOnce();
  });

  it('removes cached optional services when complete evidence withdraws their members', () => {
    const target = accessory();
    const sdkDevice = device(
      { enabled: true, statusLed: false, setStatusLed: vi.fn() },
      { isOn: true, brightness: 50, set: vi.fn(), setBrightness: vi.fn() },
    );
    attach(target, sdkDevice);

    attach(target, sdkDevice, new Map([['camera.enabled.read', requirement('camera.enabled.read')]]));

    expect(target.getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)).toBeUndefined();
    expect(target.getServiceById(Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY)).toBeUndefined();
  });

  it('retains a late unsupported result across adapter replacement', async () => {
    const target = accessory();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<void>((_, reject) => {
      rejectOperation = reject;
    });
    const setStatusLed = vi.fn(() => operation);
    const sdkDevice = device({ enabled: true, statusLed: false, setStatusLed });
    const first = attach(target, sdkDevice)!;
    const on = target
      .getServiceById(Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY)!
      .getCharacteristic(Characteristic.On);
    const pending = on.handleSetRequest(true);
    await vi.waitFor(() => expect(setStatusLed).toHaveBeenCalledOnce());

    attach(target, sdkDevice);
    first.detach?.();
    await expect(pending).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    rejectOperation(new CapabilityNotSupportedError('synthetic-camera', 'statusLed'));
    await vi.waitFor(() => expect(on.handleSetRequest(true)).rejects.toBe(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    expect(setStatusLed).toHaveBeenCalledOnce();
  });
});

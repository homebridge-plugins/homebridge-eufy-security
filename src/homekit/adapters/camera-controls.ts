import {
  CapabilityNotSupportedError,
  type AudioActions,
  type CameraActions,
  type LightActions,
} from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const CAMERA_CONTROLS_ADAPTER_KEY = 'camera.controls';
export const CAMERA_ENABLED_SERVICE_KEY = 'camera.enabled';
export const CAMERA_LIGHT_SERVICE_KEY = 'camera.physical-light';
export const CAMERA_STATUS_LED_SERVICE_KEY = 'camera.status-led';
export const CAMERA_MICROPHONE_SERVICE_KEY = 'camera.microphone';
export const CAMERA_SPEAKER_SERVICE_KEY = 'camera.speaker';

const CAMERA_ENABLED_READ = {
  id: 'camera.enabled.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const CAMERA_STATUS_LED_READ = {
  id: 'camera.statusLed.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const CAMERA_STATUS_LED_WRITE = {
  id: 'camera.statusLed.persistent-operation',
  kind: 'persistent-operation',
} as const;
const LIGHT_POWER_READ = {
  id: 'light.isOn.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const LIGHT_POWER_WRITE = {
  id: 'light.isOn.persistent-operation',
  kind: 'persistent-operation',
} as const;
const LIGHT_BRIGHTNESS_READ = {
  id: 'light.brightness.read',
  kind: 'read',
  type: 'number',
  writable: true,
} as const;
const LIGHT_BRIGHTNESS_WRITE = {
  id: 'light.brightness.persistent-operation',
  kind: 'persistent-operation',
} as const;
const AUDIO_MICROPHONE_READ = {
  id: 'audio.microphone.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const AUDIO_MICROPHONE_WRITE = {
  id: 'audio.microphone.persistent-operation',
  kind: 'persistent-operation',
} as const;
const AUDIO_SPEAKER_READ = {
  id: 'audio.speaker.read',
  kind: 'read',
  type: 'bool',
  writable: true,
} as const;
const AUDIO_SPEAKER_WRITE = {
  id: 'audio.speaker.persistent-operation',
  kind: 'persistent-operation',
} as const;
const AUDIO_VOLUME_READ = {
  id: 'audio.volume.read',
  kind: 'read',
  type: 'number',
  writable: true,
} as const;
const AUDIO_VOLUME_WRITE = {
  id: 'audio.volume.persistent-operation',
  kind: 'persistent-operation',
} as const;

const CAMERA_CONTROL_ROWS = [
  CAMERA_ENABLED_READ,
  CAMERA_STATUS_LED_READ,
  CAMERA_STATUS_LED_WRITE,
  LIGHT_POWER_READ,
  LIGHT_POWER_WRITE,
  LIGHT_BRIGHTNESS_READ,
  LIGHT_BRIGHTNESS_WRITE,
  AUDIO_MICROPHONE_READ,
  AUDIO_MICROPHONE_WRITE,
  AUDIO_SPEAKER_READ,
  AUDIO_SPEAKER_WRITE,
  AUDIO_VOLUME_READ,
  AUDIO_VOLUME_WRITE,
] as const;
const CAMERA_CONTROL_OWNERS = new WeakMap<object, symbol>();

/** Operation lifetime retained by the stable enabled service across adapter replacement. */
interface CameraControlsState {
  owner: symbol;
  activeOperations: Map<string, Promise<void>>;
  blockedOperations: Set<string>;
}
const CAMERA_CONTROL_STATES = new WeakMap<object, CameraControlsState>();
const OPERATION_DEADLINE_MS = 8_000;
const OPERATION_TIMEOUT = Symbol('camera-control-operation-timeout');

/** The typed SDK camera, physical-light, and audio accessors consumed by HomeKit. */
export interface CameraControlsSdkDevice {
  camera?: () => CameraActions | undefined;
  light?: () => LightActions | undefined;
  audio?: () => AudioActions | undefined;
}

/** Complete HomeKit policy for the independent controls attached to an evidenced camera. */
export const CAMERA_CONTROLS_ADAPTER = {
  key: CAMERA_CONTROLS_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [CAMERA_ENABLED_READ],
  coverage: CAMERA_CONTROL_ROWS.map(({ id }) => ({
    id,
    hapFit: 'Official camera, light, microphone, and speaker services expose only matching SDK semantics',
    identityEffect: 'Primary-purpose camera controls use stable service-specific semantic keys',
    diagnostics: 'Missing or malformed typed members fail closed without shape-driven fallback mappings',
    verification: [
      {
        file: 'test/contracts/camera-controls-adapter.test.ts',
        behavior: 'keeps the physical camera light and unified status LED as separate authoritative services',
      },
      {
        file: 'test/contracts/homekit-reconciler.test.ts',
        behavior: 'admits camera controls only from exact enabled-member evidence',
      },
    ],
  })),
  attach: attachCameraControls,
} as const satisfies HomeKitAdapter;

/** Attaches each camera control only to the official service matching that member's semantics. */
function attachCameraControls(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const { accessory, hap } = context;
  const device = context.device as CameraControlsSdkDevice;
  let camera: CameraActions | undefined;
  try {
    camera = device.camera?.();
  } catch {
    context.diagnose({
      code: 'camera-controls-capability-unavailable',
      capability: 'camera',
      member: 'enabled',
      active: true,
      reason: 'sdk-fault',
    });
    return undefined;
  }
  if (!camera) {
    context.diagnose({
      code: 'camera-controls-capability-unavailable',
      capability: 'camera',
      member: 'enabled',
      active: true,
      reason: 'missing',
    });
    return undefined;
  }
  context.diagnose({
    code: 'camera-controls-capability-unavailable',
    capability: 'camera',
    member: 'enabled',
    active: false,
    reason: 'recovered',
  });

  const services: object[] = [];
  const owner = Symbol('camera-controls-owner');
  const detachRejectors = new Set<(error: unknown) => void>();
  let detached = false;
  const own = <T extends object>(service: T): T => {
    CAMERA_CONTROL_OWNERS.set(service, owner);
    services.push(service);
    return service;
  };
  const readBoolean = (capability: string, member: string, read: () => unknown): boolean => {
    let value: unknown;
    try {
      value = read();
    } catch {
      context.diagnose({
        code: 'invalid-camera-control-observation',
        capability,
        member,
        active: true,
        reason: 'sdk-fault',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (typeof value !== 'boolean') {
      context.diagnose({
        code: 'invalid-camera-control-observation',
        capability,
        member,
        active: true,
        reason: value === undefined ? 'missing' : 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    context.diagnose({
      code: 'invalid-camera-control-observation',
      capability,
      member,
      active: false,
      reason: 'recovered',
    });
    return value;
  };
  const readPercent = (capability: string, member: string, minimum: number, read: () => unknown): number => {
    let value: unknown;
    try {
      value = read();
    } catch {
      context.diagnose({
        code: 'invalid-camera-control-observation',
        capability,
        member,
        active: true,
        reason: 'sdk-fault',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 100) {
      context.diagnose({
        code: 'invalid-camera-control-observation',
        capability,
        member,
        active: true,
        reason: value === undefined ? 'missing' : 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    context.diagnose({
      code: 'invalid-camera-control-observation',
      capability,
      member,
      active: false,
      reason: 'recovered',
    });
    return value;
  };

  const enabledService = own(
    accessory.getServiceById(hap.Service.Switch, CAMERA_ENABLED_SERVICE_KEY) ??
      accessory.addService(hap.Service.Switch, 'Camera Enabled', CAMERA_ENABLED_SERVICE_KEY),
  );
  enabledService
    .getCharacteristic(hap.Characteristic.On)
    .onGet(() => readBoolean('camera', 'enabled', () => camera.enabled));
  enabledService.getCharacteristic(hap.Characteristic.On).onSet(() => {
    throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
  });
  const previousState = CAMERA_CONTROL_STATES.get(enabledService);
  const state: CameraControlsState = {
    owner,
    activeOperations: previousState?.activeOperations ?? new Map(),
    blockedOperations: previousState?.blockedOperations ?? new Set(),
  };
  CAMERA_CONTROL_STATES.set(enabledService, state);

  const matches = (requirement: (typeof CAMERA_CONTROL_ROWS)[number]): boolean => {
    const installed = context.evidence.get(requirement.id);
    return (
      installed?.kind === requirement.kind &&
      (!('type' in requirement) || installed.type === requirement.type) &&
      (!('writable' in requirement) || installed.writable === requirement.writable)
    );
  };
  const unavailable = (
    capability: string,
    member: string,
    active: boolean,
    reason: 'missing' | 'malformed' | 'sdk-fault' | 'recovered',
  ): void => {
    context.diagnose({
      code: 'camera-controls-capability-unavailable',
      capability,
      member,
      active,
      reason,
    });
  };
  const issue = async (
    capability: string,
    member: string,
    operation: () => Promise<void>,
    restore: () => void,
  ): Promise<void> => {
    const key = `${capability}.${member}`;
    if (state.blockedOperations.has(key)) {
      throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (state.activeOperations.has(key)) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const operationPromise = Promise.resolve().then(operation);
    state.activeOperations.set(key, operationPromise);
    void operationPromise.then(
      () => state.activeOperations.delete(key),
      (error) => {
        state.activeOperations.delete(key);
        if (error instanceof CapabilityNotSupportedError) {
          state.blockedOperations.add(key);
        }
      },
    );
    let rejectDetached!: (error: unknown) => void;
    const detachedPromise = new Promise<never>((_, reject) => {
      rejectDetached = reject;
    });
    detachRejectors.add(rejectDetached);
    try {
      await Promise.race([
        operationPromise,
        detachedPromise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(OPERATION_TIMEOUT), OPERATION_DEADLINE_MS);
        }),
      ]);
      if (!detached && CAMERA_CONTROL_STATES.get(enabledService)?.owner === owner) {
        context.diagnose({
          code: 'camera-control-operation-failed',
          capability,
          member,
          active: false,
          reason: 'recovered',
        });
        queueMicrotask(() => {
          if (!detached && CAMERA_CONTROL_STATES.get(enabledService)?.owner === owner) {
            restore();
          }
        });
      }
    } catch (error) {
      const unsupported = error instanceof CapabilityNotSupportedError;
      if (unsupported) {
        state.blockedOperations.add(key);
      }
      if (!detached && CAMERA_CONTROL_STATES.get(enabledService)?.owner === owner) {
        context.diagnose({
          code: 'camera-control-operation-failed',
          capability,
          member,
          active: true,
          reason: unsupported
            ? 'capability-not-supported'
            : error === OPERATION_TIMEOUT
              ? 'timeout'
              : 'operation-failure',
        });
      }
      throw new hap.HapStatusError(
        unsupported ? hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE : hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    } finally {
      detachRejectors.delete(rejectDetached);
      if (deadline) {
        clearTimeout(deadline);
      }
    }
  };

  const clearMemberDiagnostics = (capability: string, member: string): void => {
    for (const code of [
      'camera-controls-capability-unavailable',
      'invalid-camera-control-observation',
      'camera-control-operation-failed',
    ]) {
      context.diagnose({ code, capability, member, active: false, reason: 'recovered' });
    }
  };
  const removeService = (serviceType: typeof hap.Service.Switch, key: string): void => {
    const service = accessory.getServiceById(serviceType, key);
    if (service) {
      CAMERA_CONTROL_OWNERS.delete(service);
      accessory.removeService(service);
    }
  };
  const evidenceState = (...requirements: (typeof CAMERA_CONTROL_ROWS)[number][]): 'absent' | 'malformed' | 'valid' => {
    const installed = requirements.some(({ id }) => context.evidence.has(id));
    return !installed ? 'absent' : requirements.every(matches) ? 'valid' : 'malformed';
  };

  const statusLedEvidence = evidenceState(CAMERA_STATUS_LED_READ, CAMERA_STATUS_LED_WRITE);
  if (statusLedEvidence === 'valid') {
    if (typeof camera.setStatusLed !== 'function') {
      removeService(hap.Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY);
      unavailable('camera', 'statusLed', true, 'missing');
    } else {
      unavailable('camera', 'statusLed', false, 'recovered');
      const statusLed = own(
        accessory.getServiceById(hap.Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY) ??
          accessory.addService(hap.Service.Switch, 'Status LED', CAMERA_STATUS_LED_SERVICE_KEY),
      );
      const on = statusLed.getCharacteristic(hap.Characteristic.On);
      const readStatusLed = (): boolean => readBoolean('camera', 'statusLed', () => camera.statusLed);
      on.onGet(readStatusLed);
      on.onSet((value) => {
        if (typeof value !== 'boolean') {
          throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        return issue(
          'camera',
          'statusLed',
          () => camera.setStatusLed!(value),
          () => {
            try {
              on.updateValue(readStatusLed());
            } catch {}
          },
        );
      });
    }
  } else {
    removeService(hap.Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY);
    if (statusLedEvidence === 'malformed') {
      unavailable('camera', 'statusLed', true, 'malformed');
    } else {
      clearMemberDiagnostics('camera', 'statusLed');
    }
  }

  let light: LightActions | undefined;
  let lightFault = false;
  try {
    light = device.light?.();
  } catch {
    lightFault = true;
    light = undefined;
  }
  const lightPowerEvidence = evidenceState(LIGHT_POWER_READ, LIGHT_POWER_WRITE);
  if (lightPowerEvidence === 'valid') {
    if (!light || typeof light.set !== 'function') {
      removeService(hap.Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY);
      unavailable('light', 'isOn', true, lightFault ? 'sdk-fault' : 'missing');
      const brightnessEvidence = evidenceState(LIGHT_BRIGHTNESS_READ, LIGHT_BRIGHTNESS_WRITE);
      if (brightnessEvidence === 'valid') {
        unavailable('light', 'brightness', true, lightFault ? 'sdk-fault' : 'missing');
      } else if (brightnessEvidence === 'malformed') {
        unavailable('light', 'brightness', true, 'malformed');
      } else {
        clearMemberDiagnostics('light', 'brightness');
      }
    } else {
      unavailable('light', 'isOn', false, 'recovered');
      const physicalLight = own(
        accessory.getServiceById(hap.Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY) ??
          accessory.addService(hap.Service.Lightbulb, 'Camera Light', CAMERA_LIGHT_SERVICE_KEY),
      );
      const power = physicalLight.getCharacteristic(hap.Characteristic.On);
      const readPower = (): boolean => readBoolean('light', 'isOn', () => light.isOn);
      power.onGet(readPower);
      power.onSet((value) => {
        if (typeof value !== 'boolean') {
          throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        return issue(
          'light',
          'isOn',
          () => light.set!(value),
          () => {
            try {
              power.updateValue(readPower());
            } catch {}
          },
        );
      });
      const brightnessEvidence = evidenceState(LIGHT_BRIGHTNESS_READ, LIGHT_BRIGHTNESS_WRITE);
      if (brightnessEvidence === 'valid') {
        if (typeof light.setBrightness !== 'function') {
          if (physicalLight.testCharacteristic(hap.Characteristic.Brightness)) {
            physicalLight.removeCharacteristic(physicalLight.getCharacteristic(hap.Characteristic.Brightness));
          }
          unavailable('light', 'brightness', true, 'missing');
        } else {
          unavailable('light', 'brightness', false, 'recovered');
          physicalLight.addOptionalCharacteristic(hap.Characteristic.Brightness);
          const brightness = physicalLight.getCharacteristic(hap.Characteristic.Brightness);
          const readBrightness = (): number => readPercent('light', 'brightness', 1, () => light.brightness);
          brightness.onGet(readBrightness);
          brightness.onSet((value) => {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
              throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
            }
            return issue(
              'light',
              'brightness',
              () => light.setBrightness!(value),
              () => {
                try {
                  brightness.updateValue(readBrightness());
                } catch {}
              },
            );
          });
        }
      } else {
        if (physicalLight.testCharacteristic(hap.Characteristic.Brightness)) {
          physicalLight.removeCharacteristic(physicalLight.getCharacteristic(hap.Characteristic.Brightness));
        }
        if (brightnessEvidence === 'malformed') {
          unavailable('light', 'brightness', true, 'malformed');
        } else {
          clearMemberDiagnostics('light', 'brightness');
        }
      }
    }
  } else {
    removeService(hap.Service.Lightbulb, CAMERA_LIGHT_SERVICE_KEY);
    if (lightPowerEvidence === 'malformed') {
      unavailable('light', 'isOn', true, 'malformed');
    } else {
      clearMemberDiagnostics('light', 'isOn');
      clearMemberDiagnostics('light', 'brightness');
    }
  }

  let audio: AudioActions | undefined;
  let audioFault = false;
  try {
    audio = device.audio?.();
  } catch {
    audioFault = true;
    audio = undefined;
  }
  const microphoneEvidence = evidenceState(AUDIO_MICROPHONE_READ, AUDIO_MICROPHONE_WRITE);
  if (microphoneEvidence === 'valid') {
    if (!audio || typeof audio.setMicrophone !== 'function') {
      removeService(hap.Service.Microphone, CAMERA_MICROPHONE_SERVICE_KEY);
      unavailable('audio', 'microphone', true, audioFault ? 'sdk-fault' : 'missing');
    } else {
      unavailable('audio', 'microphone', false, 'recovered');
      const microphone = own(
        accessory.getServiceById(hap.Service.Microphone, CAMERA_MICROPHONE_SERVICE_KEY) ??
          accessory.addService(hap.Service.Microphone, 'Microphone', CAMERA_MICROPHONE_SERVICE_KEY),
      );
      const mute = microphone.getCharacteristic(hap.Characteristic.Mute);
      const readMute = (): boolean => !readBoolean('audio', 'microphone', () => audio.microphone);
      mute.onGet(readMute);
      mute.onSet((value) => {
        if (typeof value !== 'boolean') {
          throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        return issue(
          'audio',
          'microphone',
          () => audio.setMicrophone!(!value),
          () => {
            try {
              mute.updateValue(readMute());
            } catch {}
          },
        );
      });
    }
  } else {
    removeService(hap.Service.Microphone, CAMERA_MICROPHONE_SERVICE_KEY);
    if (microphoneEvidence === 'malformed') {
      unavailable('audio', 'microphone', true, 'malformed');
    } else {
      clearMemberDiagnostics('audio', 'microphone');
    }
  }
  const speakerEvidence = evidenceState(AUDIO_SPEAKER_READ, AUDIO_SPEAKER_WRITE);
  if (speakerEvidence === 'valid') {
    if (!audio || typeof audio.setSpeaker !== 'function') {
      removeService(hap.Service.Speaker, CAMERA_SPEAKER_SERVICE_KEY);
      unavailable('audio', 'speaker', true, audioFault ? 'sdk-fault' : 'missing');
      const volumeEvidence = evidenceState(AUDIO_VOLUME_READ, AUDIO_VOLUME_WRITE);
      if (volumeEvidence === 'valid') {
        unavailable('audio', 'volume', true, audioFault ? 'sdk-fault' : 'missing');
      } else if (volumeEvidence === 'malformed') {
        unavailable('audio', 'volume', true, 'malformed');
      } else {
        clearMemberDiagnostics('audio', 'volume');
      }
    } else {
      unavailable('audio', 'speaker', false, 'recovered');
      const speaker = own(
        accessory.getServiceById(hap.Service.Speaker, CAMERA_SPEAKER_SERVICE_KEY) ??
          accessory.addService(hap.Service.Speaker, 'Speaker', CAMERA_SPEAKER_SERVICE_KEY),
      );
      const mute = speaker.getCharacteristic(hap.Characteristic.Mute);
      const readMute = (): boolean => !readBoolean('audio', 'speaker', () => audio.speaker);
      mute.onGet(readMute);
      mute.onSet((value) => {
        if (typeof value !== 'boolean') {
          throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        return issue(
          'audio',
          'speaker',
          () => audio.setSpeaker!(!value),
          () => {
            try {
              mute.updateValue(readMute());
            } catch {}
          },
        );
      });
      const volumeEvidence = evidenceState(AUDIO_VOLUME_READ, AUDIO_VOLUME_WRITE);
      if (volumeEvidence === 'valid') {
        if (typeof audio.setVolume !== 'function') {
          if (speaker.testCharacteristic(hap.Characteristic.Volume)) {
            speaker.removeCharacteristic(speaker.getCharacteristic(hap.Characteristic.Volume));
          }
          unavailable('audio', 'volume', true, 'missing');
        } else {
          unavailable('audio', 'volume', false, 'recovered');
          speaker.addOptionalCharacteristic(hap.Characteristic.Volume);
          const volume = speaker.getCharacteristic(hap.Characteristic.Volume);
          const readVolume = (): number => readPercent('audio', 'volume', 0, () => audio.volume);
          volume.onGet(readVolume);
          volume.onSet((value) => {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
              throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
            }
            return issue(
              'audio',
              'volume',
              () => audio.setVolume!(value),
              () => {
                try {
                  volume.updateValue(readVolume());
                } catch {}
              },
            );
          });
        }
      } else {
        if (speaker.testCharacteristic(hap.Characteristic.Volume)) {
          speaker.removeCharacteristic(speaker.getCharacteristic(hap.Characteristic.Volume));
        }
        if (volumeEvidence === 'malformed') {
          unavailable('audio', 'volume', true, 'malformed');
        } else {
          clearMemberDiagnostics('audio', 'volume');
        }
      }
    }
  } else {
    removeService(hap.Service.Speaker, CAMERA_SPEAKER_SERVICE_KEY);
    if (speakerEvidence === 'malformed') {
      unavailable('audio', 'speaker', true, 'malformed');
    } else {
      clearMemberDiagnostics('audio', 'speaker');
      clearMemberDiagnostics('audio', 'volume');
    }
  }

  return {
    detach(): void {
      detached = true;
      const detachedError = new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      for (const reject of detachRejectors) {
        reject(detachedError);
      }
      detachRejectors.clear();
      for (const service of services) {
        if (CAMERA_CONTROL_OWNERS.get(service) === owner) {
          CAMERA_CONTROL_OWNERS.delete(service);
          accessory.removeService(service as never);
        }
      }
      if (CAMERA_CONTROL_STATES.get(enabledService)?.owner === owner) {
        CAMERA_CONTROL_STATES.delete(enabledService);
      }
    },
  };
}

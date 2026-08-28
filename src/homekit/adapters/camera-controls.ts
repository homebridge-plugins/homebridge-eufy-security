import { unreflectedMembers, type AudioActions, type CameraActions, type LightActions } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AdapterEventTrace, AttachedAdapter, HomeKitAdapter } from '../adapter.js';
import {
  deviceOperationIssuer,
  enablementAnnouncement,
  INVALID_OBSERVATION_CONDITION,
  observationReader,
  OPERATION_FAILED_CONDITION,
  type DeviceOperationState,
} from '../device-control.js';

export const CAMERA_CONTROLS_ADAPTER_KEY = 'camera.controls';
export const CAMERA_ENABLED_SERVICE_KEY = 'camera.enabled';
export const CAMERA_LIGHT_SERVICE_KEY = 'camera.physical-light';
/** The switch an earlier version published for the indicator LED, retained only to withdraw it. */
export const CAMERA_STATUS_LED_SERVICE_KEY = 'camera.status-led';
export const CAMERA_MICROPHONE_SERVICE_KEY = 'camera.microphone';
export const CAMERA_SPEAKER_SERVICE_KEY = 'camera.speaker';

const CAMERA_ENABLED_READ = {
  id: 'camera.enabled.read',
  kind: 'read',
  type: 'bool',
  writable: true,
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
/**
 * Writing the camera's power, gated here without a coverage row of its own: the camera streaming bundle
 * carries HomeKit's own camera-active state to this same member and declares the operation once, so a second
 * row would claim one operation twice.
 */
const CAMERA_ENABLED_WRITE = { id: 'camera.enabled.persistent-operation', kind: 'persistent-operation' } as const;
const CAMERA_CONTROL_REQUIREMENTS = [...CAMERA_CONTROL_ROWS, CAMERA_ENABLED_WRITE] as const;
type CameraControlRequirement = (typeof CAMERA_CONTROL_REQUIREMENTS)[number];

/**
 * What the camera's power reading owes HomeKit beyond answering a read, and who proves it.
 *
 * Stated on the read rather than on an event row of its own because the SDK announces this member moving
 * through its one generic property announcement, which is not a capability event and so has no row in the
 * member surface: following it is part of how this read is presented, not a second member. Both camera bundles
 * follow it — this one keeps its switch honest, the streaming bundle ends a session watching a camera that just
 * went off — so the row names both, since a member two bundles present from cannot be evidenced by one.
 */
const CAMERA_ENABLED_READ_COVERAGE = {
  hapFit:
    'The enablement observation is answered on demand and pushed when the SDK announces the property moved, so a camera switched off in the vendor app or by a physical switch is shown as off rather than left showing the old state; the camera streaming bundle follows the same announcement to end a session watching a camera that just went off, and falls back to a supervision read where nothing announced the change; it is deliberately published as no HomeKit state on the operating mode service, because Apple Home stops writing the operating mode of a camera reporting itself manually disabled and that made a recoverable failure permanent',
  identityEffect:
    "Presented on the switch under the stable semantic key camera.enabled, and for session lifetime on the recording controller's own operating mode service where HomeKit Secure Video created one, otherwise one service under the stable semantic key camera.operating-mode, so an accessory carries exactly one",
  diagnostics:
    'An absent, non-boolean, faulting, or SDK-declined enablement reading withdraws no camera and refuses no session; each announced change records one identity-free trace naming whether the observation answered and whether a write or the generic announcement carried it',
  verification: [
    {
      file: 'test/contracts/camera-controls-adapter.test.ts',
      behavior: 'announces the camera power to HomeKit when something else changed it',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'withdraws the disabled state an earlier version published, and the record it kept for it',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'ends the session from the supervision read when nothing announced the change',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'follows the enablement change event rather than a timer',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'ends an active session on the enablement change event instead of waiting for the next read',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'presents no operating mode state without an exactly evidenced boolean enablement observation',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'declines an enablement observation the SDK names as unreflected',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'withdraws a published disabled state when a reconciliation leaves no observation to act on',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'presents on an operating mode service the accessory restored from a run that configured recording',
    },
    {
      file: 'test/contracts/camera-streaming-adapter.test.ts',
      behavior: 'withdraws a stale operating mode service before the recording controller attaches its own',
    },
  ],
} as const;
const CAMERA_CONTROL_OWNERS = new WeakMap<object, symbol>();

const CAMERA_CONTROL_STATES = new WeakMap<object, DeviceOperationState>();

/**
 * Whether the SDK declines to stand behind one of this camera's readings on this device family.
 *
 * A member named there reports a value that does not track its own setter, so writing it would leave HomeKit
 * unable to tell whether the write landed. The statement is read off the bound capability surface itself, so a
 * surface that answers that read by throwing has stated nothing this plugin may rely on and is declined too.
 */
function declined(camera: CameraActions, member: string): boolean {
  try {
    return unreflectedMembers(camera).includes(member);
  } catch {
    return true;
  }
}

/** The typed SDK camera, physical-light, and audio accessors consumed by HomeKit. */
export interface CameraControlsSdkDevice {
  camera?: () => CameraActions | undefined;
  light?: () => LightActions | undefined;
  audio?: () => AudioActions | undefined;
}

/** The shared policy every camera-control row states, which the enablement read then specialises. */
const CAMERA_CONTROL_COVERAGE_DEFAULTS = {
  hapFit: 'Official camera, light, microphone, and speaker services expose only matching SDK semantics',
  identityEffect: 'Primary-purpose camera controls use stable service-specific semantic keys',
  diagnostics: 'Missing or malformed typed members fail closed without shape-driven fallback mappings',
  verification: [
    {
      file: 'test/contracts/camera-controls-adapter.test.ts',
      behavior: 'keeps the physical camera light distinct from the enabled state and from mute',
    },
    {
      file: 'test/contracts/homekit-reconciler.test.ts',
      behavior: 'admits camera controls only from exact enabled-member evidence',
    },
  ],
} as const;

/** Complete HomeKit policy for the independent controls attached to an evidenced camera. */
export const CAMERA_CONTROLS_ADAPTER = {
  key: CAMERA_CONTROLS_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [CAMERA_ENABLED_READ],
  coverage: CAMERA_CONTROL_ROWS.map(({ id }) =>
    id === CAMERA_ENABLED_READ.id
      ? {
          id,
          ...CAMERA_ENABLED_READ_COVERAGE,
          verification: [
            ...CAMERA_CONTROL_COVERAGE_DEFAULTS.verification,
            ...CAMERA_ENABLED_READ_COVERAGE.verification,
          ],
        }
      : { id, ...CAMERA_CONTROL_COVERAGE_DEFAULTS },
  ),
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
  const readBoolean = observationReader(context, 'boolean');

  const readNumber = observationReader(context, 'number');
  /**
   * One authoritative numeric observation reduced to a HomeKit percentage, rejecting a value outside the
   * range HomeKit accepts rather than clamping it, because a value out of range is a value this plugin has
   * not understood.
   */
  const readPercent = (capability: string, member: string, minimum: number, read: () => unknown): number => {
    const value = readNumber(capability, member, read);
    if (!Number.isInteger(value) || value < minimum || value > 100) {
      context.diagnose({
        code: INVALID_OBSERVATION_CONDITION,
        capability,
        member,
        active: true,
        reason: 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  };

  const enabledService = own(
    accessory.getServiceById(hap.Service.Switch, CAMERA_ENABLED_SERVICE_KEY) ??
      accessory.addService(hap.Service.Switch, 'Camera Enabled', CAMERA_ENABLED_SERVICE_KEY),
  );
  const enabledPower = enabledService.getCharacteristic(hap.Characteristic.On);
  const readEnabled = (): boolean => readBoolean('camera', 'enabled', () => camera.enabled);
  enabledPower.onGet(readEnabled);
  const previousState = CAMERA_CONTROL_STATES.get(enabledService);
  const state: DeviceOperationState = {
    owner,
    activeOperations: previousState?.activeOperations ?? new Map(),
    blockedOperations: previousState?.blockedOperations ?? new Set(),
  };
  CAMERA_CONTROL_STATES.set(enabledService, state);

  const matches = (requirement: CameraControlRequirement): boolean => {
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
  const issue = deviceOperationIssuer({
    context,
    state,
    owned: () => CAMERA_CONTROL_STATES.get(enabledService)?.owner === owner,
    detached: () => detached,
    detachRejectors,
  });

  const clearMemberDiagnostics = (capability: string, member: string): void => {
    for (const code of [
      'camera-controls-capability-unavailable',
      INVALID_OBSERVATION_CONDITION,
      OPERATION_FAILED_CONDITION,
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
  const evidenceState = (...requirements: CameraControlRequirement[]): 'absent' | 'malformed' | 'valid' => {
    const installed = requirements.some(({ id }) => context.evidence.has(id));
    return !installed ? 'absent' : requirements.every(matches) ? 'valid' : 'malformed';
  };

  /**
   * Switches the camera's power from HomeKit, which is the only control that stays reachable once the camera
   * is off.
   *
   * A camera reporting itself disabled is one Apple Home declines to write the camera operating mode of at
   * all — measured on a real home — so the operating mode service cannot be the way back on. A plain switch
   * carries no such meaning and Home delivers writes to it, which is why this one must not merely report the
   * state it reads. Where the camera's power cannot be written the switch still refuses, but now says so
   * instead of failing silently.
   */
  const enablementWritable =
    evidenceState(CAMERA_ENABLED_WRITE) === 'valid' &&
    typeof camera.setEnabled === 'function' &&
    !declined(camera, 'enabled');
  if (enablementWritable) {
    unavailable('camera', 'enabled', false, 'recovered');
  }
  enabledPower.onSet((value) => {
    if (!enablementWritable) {
      unavailable('camera', 'enabled', true, 'missing');
      throw new hap.HapStatusError(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (typeof value !== 'boolean') {
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    return issue(
      'camera',
      'enabled',
      () => camera.setEnabled!(value),
      () => undefined,
    ).catch((error: unknown) => {
      try {
        enabledPower.updateValue(readEnabled());
      } catch {}
      throw error;
    });
  });

  /**
   * The indicator LED moved to the camera operating mode service, where HomeKit calls it the camera
   * operating mode indicator and the Home app shows it as the camera's status light. A switch published for
   * it by an earlier version is withdrawn here, by the bundle that published it, so an accessory does not
   * keep a second control for one member.
   */
  removeService(hap.Service.Switch, CAMERA_STATUS_LED_SERVICE_KEY);
  clearMemberDiagnostics('camera', 'statusLed');

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
    /**
     * Keeps the Camera Enabled switch honest when the camera's power changes.
     *
     * HomeKit is not told a characteristic moved unless the accessory says so: it subscribes to notifications
     * and otherwise reads only while the Home app is open, so a switch that answers reads and never pushes shows
     * the old state indefinitely. That matters most for the change this plugin did not make — the vendor app or a
     * physical switch — which is exactly what the poll announcement reports.
     *
     * Pushed only when the value actually moved, so a repeated announcement is not a notification, and nothing is
     * pushed for a reading that faults: a switch left showing its last known state is honest, one showing a
     * guess is not.
     */
    event(event): AdapterEventTrace | undefined {
      return enablementAnnouncement(context, event, () => {
        try {
          const reading = readEnabled();
          if (enabledPower.value !== reading) {
            enabledPower.updateValue(reading);
          }
          return 'valid';
        } catch {
          return 'missing';
        }
      });
    },
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

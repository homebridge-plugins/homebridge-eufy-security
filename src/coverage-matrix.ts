import { CAPABILITY_MODULES, type CapabilityModule, type Member } from '@mega-yfue/eufy-sdk';

import { ADAPTER_REGISTRY } from './adapters/registry.js';

export type CoverageMemberKind = 'read' | 'event' | 'persistent-operation' | 'momentary-action';
export type CoverageDisposition = 'required-adapter' | 'diagnostic-only' | 'blocked-sdk-gap' | 'explicitly-deferred';

export interface CoverageRow {
  id: string;
  capability: string;
  member: string;
  memberKind: CoverageMemberKind;
  evidence: string[];
  hapFit: string;
  disposition: CoverageDisposition;
  adapter: string | null;
  representationStatus: 'represented' | 'not-represented';
  controlStatus: 'not-controllable' | 'not-represented';
  identityEffect: string;
  diagnostics: string;
  verification: CoverageVerification[];
  followUp?: string;
}

export interface CoverageVerification {
  file: string;
  behavior: string;
}

export interface SdkHapCoverageMatrix {
  version: 1;
  sdkContract: string;
  hapContract: string;
  rows: CoverageRow[];
}

const KNOWN_SDK_SURFACE = {
  rtsp: [
    'published.read',
    'published.persistent-operation',
    'recordingMode.read',
    'recordingMode.persistent-operation',
    'publish.momentary-action',
    'withdraw.momentary-action',
    'requireAuth.momentary-action',
    'allowAnonymous.momentary-action',
    'setRecordingMode.momentary-action',
  ],
  motion: [
    'detectionEnabled.read',
    'detectionEnabled.persistent-operation',
    'aiDetectType.read',
    'aiDetectType.persistent-operation',
    'testMode.read',
    'testMode.persistent-operation',
    'snoozeTime.read',
    'snoozeTime.persistent-operation',
    'humanOnlyAtNight.read',
    'humanOnlyAtNight.persistent-operation',
    'loiteringDetection.read',
    'loiteringDetection.persistent-operation',
    'motionSensitivity.read',
    'soloSensitivity.read',
    'indoorSensitivity.read',
    'pirSensitivityRaw.read',
    'sensorPirSensitivity.read',
    'motion.event',
    'cryingDetected.event',
    'soundDetected.event',
    'vehicleDetected.event',
    'dogDetected.event',
  ],
  person_detection: ['detectionEnabled.read', 'detected.read', 'personDetected.event', 'strangerDetected.event'],
  battery: [
    'level.read',
    'charging.read',
    'powerSource.read',
    'powerSource.persistent-operation',
    'workingMode.read',
    'workingMode.persistent-operation',
    'recordDuration.read',
    'recordDuration.persistent-operation',
    'recordInterval.read',
    'recordInterval.persistent-operation',
    'recordAutoStop.read',
    'recordAutoStop.persistent-operation',
    'temperature.read',
    'health.read',
    'solarIntensity.read',
    'solarConnected24h.read',
    'batteryPowerStats.read',
    'cameraInfo.read',
    'batteryLevel.event',
    'batteryAlert.event',
  ],
  light: [
    'isOn.read',
    'isOn.persistent-operation',
    'brightness.read',
    'brightness.persistent-operation',
    'colorTemp.persistent-operation',
    'spotlightEnabled.persistent-operation',
  ],
  smart_light: [
    'power.read',
    'power.persistent-operation',
    'brightness.read',
    'brightness.persistent-operation',
    'lightLength.read',
    'effectId.read',
    'colorGradient.read',
    'cloudEffectId.read',
    'lightEffectMode.read',
    'refreshState.momentary-action',
    'setEffect.momentary-action',
    'smartLightState.event',
  ],
  ptz: [
    'rotationSpeed.read',
    'panAngle.read',
    'tiltAngle.read',
    'rotate.momentary-action',
    'left.momentary-action',
    'right.momentary-action',
    'up.momentary-action',
    'down.momentary-action',
    'zoom.momentary-action',
    'preset.read',
    'ptzNotify.event',
  ],
  camera: [
    'enabled.read',
    'enabled.persistent-operation',
    'imageFlipped.read',
    'imageFlipped.persistent-operation',
    'watermark.read',
    'watermark.persistent-operation',
    'nightVision.read',
    'nightVision.persistent-operation',
    'videoQuality.read',
    'videoQuality.persistent-operation',
    'antiTheftDetection.read',
    'antiTheftDetection.persistent-operation',
    'privacy.persistent-operation',
    'statusLed.read',
    'statusLed.persistent-operation',
    'snapshotStored.momentary-action',
    'snapshotLive.momentary-action',
    'live.momentary-action',
    'record.momentary-action',
    'openReadable.momentary-action',
    'recordFragments.momentary-action',
    'talkback.momentary-action',
  ],
  audio: [
    'microphone.read',
    'microphone.persistent-operation',
    'speaker.read',
    'speaker.persistent-operation',
    'volume.read',
    'volume.persistent-operation',
    'audioRecording.read',
    'audioRecording.persistent-operation',
    'ringtoneVolume.persistent-operation',
    'alarmVolume.persistent-operation',
    'promptVolume.persistent-operation',
    'alarmTone.read',
    'alarmTone.persistent-operation',
  ],
  doorbell: [
    'chimeSwitch.read',
    'chimeSwitch.persistent-operation',
    'mechanicalChimeSwitch.read',
    'mechanicalChimeSwitch.persistent-operation',
    'wdrSwitch.read',
    'wdrSwitch.persistent-operation',
    'ringtoneVolume.read',
    'ringtoneVolume.persistent-operation',
    'dingdongVolume.read',
    'dingdongVolume.persistent-operation',
    'dingdongRingtone.read',
    'dingdongRingtone.persistent-operation',
    'notificationMode.read',
    'playQuickResponse.momentary-action',
    'quickResponses.momentary-action',
    'doorbellPress.event',
    'petDetection.event',
    'packageDelivered.event',
    'packageTaken.event',
    'packageStranded.event',
  ],
  contact: [
    'open.read',
    'lastSeen.read',
    'rssi.read',
    'alarmSoundType.read',
    'alarmSoundType.persistent-operation',
    'alarmVolume.read',
    'alarmVolume.persistent-operation',
    'contactState.event',
  ],
  leak: ['leakDetected.read', 'lastSeen.read'],
  smoke: ['smokeDetected.read', 'lastSeen.read'],
  co: ['coDetected.read', 'lastSeen.read'],
  siren: [
    'active.read',
    'volume.read',
    'volume.persistent-operation',
    'alarmDuration.read',
    'alarmDuration.persistent-operation',
    'doNotDisturb.read',
    'test.momentary-action',
    'stop.momentary-action',
  ],
  lock: [
    'locked.read',
    'locked.persistent-operation',
    'battery.read',
    'rssi.read',
    'lock.momentary-action',
    'unlock.momentary-action',
    'setAutoLock.momentary-action',
    'setRainMode.momentary-action',
    'oneTouchLock.persistent-operation',
    'scramblePasscode.persistent-operation',
    'wifiStatus.persistent-operation',
    'logEnabled.persistent-operation',
    'privacyMode.persistent-operation',
    'oneTouchRearLock.persistent-operation',
    'getAutoLockState.read',
    'lockState.event',
  ],
  keypad: ['rssi.read', 'batteryLow.read', 'charging.read'],
  arming: [
    'mode.read',
    'mode.persistent-operation',
    'setAlarmDelayConfig.momentary-action',
    'armingModeChanged.event',
    'alarm.event',
  ],
  storage: ['sdCard.read', 'free.read', 'total.read'],
  vacuum_clean: [
    'power.read',
    'power.persistent-operation',
    'activity.read',
    'volume.read',
    'battery.read',
    'cleanType.read',
    'startCleaning.momentary-action',
    'returnToDock.momentary-action',
    'pauseCleaning.momentary-action',
  ],
  suction: ['level.read', 'level.persistent-operation', 'boostIq.read', 'boostIq.persistent-operation'],
  locate: ['locating.read', 'locating.persistent-operation', 'locate.momentary-action'],
  info: [
    'manufacturer.read',
    'model.read',
    'serialNumber.read',
    'name.read',
    'deviceType.read',
    'firmwareVersion.read',
    'hardwareVersion.read',
    'firmwareSubVersion.read',
    'macAddress.read',
    'updateAvailable.read',
  ],
} as const;

const ADAPTER_BY_ROW = new Map<string, string>(
  Object.entries(ADAPTER_REGISTRY).flatMap(([adapter, registration]) =>
    registration.rows.map((row) => [row, adapter] as const),
  ),
);

const BLOCKED = new Set([
  'person_detection.detectionEnabled.read',
  'person_detection.detected.read',
  'ptz.rotationSpeed.read',
  'ptz.panAngle.read',
  'ptz.tiltAngle.read',
  'camera.imageFlipped.persistent-operation',
  'leak.leakDetected.read',
  'smoke.smokeDetected.read',
  'co.coDetected.read',
  'lock.locked.read',
  'lock.locked.persistent-operation',
  'lock.lockState.event',
  'keypad.batteryLow.read',
  'keypad.charging.read',
  'storage.sdCard.read',
  'storage.free.read',
  'storage.total.read',
]);

const DEFERRED_FOLLOW_UPS: Readonly<Record<string, string>> = {
  'info.manufacturer.read': '#986: attach identity metadata only after a primary-purpose adapter represents the device',
  'info.model.read': '#986: attach identity metadata only after a primary-purpose adapter represents the device',
  'info.serialNumber.read': '#986: attach identity metadata only after a primary-purpose adapter represents the device',
  'info.name.read': '#986: attach identity metadata only after a primary-purpose adapter represents the device',
  'info.firmwareVersion.read':
    '#986: attach identity metadata only after a primary-purpose adapter represents the device',
  'info.hardwareVersion.read':
    '#986: attach identity metadata only after a primary-purpose adapter represents the device',
};

function defer(rows: readonly string[], issue: string, risk: string): void {
  for (const row of rows) {
    DEFERRED[row] = `${issue}: ${risk}`;
  }
}

const DEFERRED: Record<string, string> = { ...DEFERRED_FOLLOW_UPS };
defer(
  [
    'camera.enabled.read',
    'camera.statusLed.read',
    'camera.statusLed.persistent-operation',
    'light.isOn.read',
    'light.isOn.persistent-operation',
    'light.brightness.read',
    'light.brightness.persistent-operation',
    'audio.microphone.read',
    'audio.microphone.persistent-operation',
    'audio.speaker.read',
    'audio.speaker.persistent-operation',
    'audio.volume.read',
    'audio.volume.persistent-operation',
  ],
  '#996',
  'requires the camera and audio bundle contracts',
);
defer(['camera.live.momentary-action'], '#997', 'requires negotiated live media adaptation');
defer(['camera.recordFragments.momentary-action'], '#999', 'requires negotiated HKSV adaptation');
defer(
  ['camera.snapshotStored.momentary-action', 'camera.snapshotLive.momentary-action'],
  '#1002',
  'requires distinct stored-only and live snapshot policy',
);
defer(['camera.talkback.momentary-action'], '#1001', 'requires isolated return-audio adaptation');
defer(
  [
    'motion.motion.event',
    'motion.cryingDetected.event',
    'motion.soundDetected.event',
    'motion.vehicleDetected.event',
    'motion.dogDetected.event',
    'person_detection.personDetected.event',
    'person_detection.strangerDetected.event',
    'doorbell.doorbellPress.event',
    'doorbell.petDetection.event',
  ],
  '#993',
  'requires retriggerable motion holds and stateless doorbell events',
);
defer(
  ['arming.mode.read', 'arming.mode.persistent-operation', 'arming.armingModeChanged.event', 'arming.alarm.event'],
  '#991',
  'requires explicit arming-mode and alarm fault policy',
);
defer(
  [
    'smart_light.power.read',
    'smart_light.power.persistent-operation',
    'smart_light.brightness.read',
    'smart_light.brightness.persistent-operation',
    'smart_light.smartLightState.event',
  ],
  '#989',
  'requires projection and partial-report reconciliation',
);
defer(
  ['siren.active.read', 'siren.test.momentary-action', 'siren.stop.momentary-action'],
  '#994',
  'requires evidence-bounded indoor-siren test behavior',
);
defer(
  ['lock.lock.momentary-action', 'lock.unlock.momentary-action'],
  '#992',
  'requires the T8531-only control boundary and unknown-current policy',
);
defer(
  ['battery.level.read', 'battery.charging.read', 'battery.batteryLevel.event', 'battery.batteryAlert.event'],
  '#995',
  'requires represented-device-only battery enrichment',
);

function parseRowId(id: string): { capability: string; member: string; memberKind: CoverageMemberKind } {
  const [capability, member, memberKind] = id.split('.');
  if (!capability || !member || !memberKind) {
    throw new TypeError(`invalid coverage row id: ${id}`);
  }
  return { capability, member, memberKind: memberKind as CoverageMemberKind };
}

function memberEvidence(module: CapabilityModule | undefined, memberName: string, kind: CoverageMemberKind): string[] {
  if (!module) {
    return [`@mega-yfue/eufy-sdk DeviceInfo.${memberName}`];
  }
  if (kind === 'event') {
    return [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability} semantic event ${memberName}`];
  }
  const member = module.members?.[memberName] as Member | undefined;
  const description = member?.description;
  return description
    ? [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability}.members.${memberName}`, description]
    : [`@mega-yfue/eufy-sdk CAPABILITY_MODULES.${module.capability}.members.${memberName}`];
}

function makeRow(id: string): CoverageRow {
  const { capability, member, memberKind } = parseRowId(id);
  const adapter = ADAPTER_BY_ROW.get(id) ?? null;
  const required = adapter !== null;
  const followUp = DEFERRED[id];
  const disposition: CoverageDisposition = required
    ? 'required-adapter'
    : BLOCKED.has(id)
      ? 'blocked-sdk-gap'
      : followUp
        ? 'explicitly-deferred'
        : 'diagnostic-only';

  return {
    id,
    capability,
    member,
    memberKind,
    evidence: memberEvidence(CAPABILITY_MODULES[capability as keyof typeof CAPABILITY_MODULES], member, memberKind),
    hapFit: required
      ? 'Contact Sensor ContactSensorState; SDK open=true maps to HAP contact not detected'
      : disposition === 'blocked-sdk-gap'
        ? 'No HAP representation is permitted without verified SDK truth'
        : disposition === 'explicitly-deferred'
          ? 'A selected official HAP contract exists but its named adapter policy is not admitted by this matrix version'
          : 'No selected semantically matching official HAP contract',
    disposition,
    adapter,
    representationStatus: required ? 'represented' : 'not-represented',
    controlStatus: required ? 'not-controllable' : 'not-represented',
    identityEffect: required
      ? 'Primary-purpose contact service uses stable semantic key contact.sensor; accessory-container identity is unchanged'
      : 'No HomeKit service or accessory identity effect',
    diagnostics:
      disposition === 'required-adapter'
        ? 'Emit and clear a structured invalid-contact-observation condition'
        : disposition === 'blocked-sdk-gap'
          ? 'Report the SDK evidence gap without representation'
          : disposition === 'explicitly-deferred'
            ? 'Report the member as deferred without representation'
            : 'Report the member as diagnostic-only without representation',
    verification: [
      {
        file: 'test/contracts/coverage-matrix.test.ts',
        behavior: 'classifies the complete current SDK member surface',
      },
      ...(required
        ? [
            {
              file: 'test/contracts/contact-adapter.test.ts',
              behavior: 'maps authoritative SDK contact polarity through real HAP definitions',
            },
          ]
        : []),
    ],
    followUp,
  };
}

const rows = Object.entries(KNOWN_SDK_SURFACE).flatMap(([capability, members]) =>
  members.map((member) => makeRow(`${capability}.${member}`)),
);

export const SDK_HAP_COVERAGE_MATRIX: SdkHapCoverageMatrix = {
  version: 1,
  sdkContract: '@mega-yfue/eufy-sdk@0.1.0-beta.11',
  hapContract: 'Homebridge 2 HAP definitions',
  rows,
};

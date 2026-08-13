import type { DeviceManifest } from '@mega-yfue/eufy-sdk';

import { describeHomeKitRepresentation } from '../homekit/representation.js';
import type { RuntimeTrackerRecord } from '../runtime/tracker.js';

const DASHBOARD_FRESH_THRESHOLD_MS = 90_000;

export type DashboardState =
  'ready' | 'degraded' | 'authentication-required' | 'owner-conflict' | 'missing' | 'stale' | 'incomplete';

export type DashboardCategory = 'security' | 'life' | 'clean';

export interface DashboardDevice {
  serial: string;
  name: string;
  modelName: string;
  category: DashboardCategory;
  deviceClass: 'camera' | 'homebase' | 'vacuum' | 'mower' | 'sensor' | 'light' | 'printer' | 'other';
  recognized: true;
  represented: boolean;
  controllable: boolean;
  diagnosticOnly: boolean;
  artwork?: string;
  preferences: Array<'represented' | 'audio' | 'snapshotMode'>;
}

export interface DashboardSnapshot {
  state: DashboardState;
  updatedAt?: string;
  devices: DashboardDevice[];
}

export interface DashboardTracker {
  read(): Promise<RuntimeTrackerRecord | null>;
}

function categoryOf(codec: DeviceManifest['codec']): DashboardCategory {
  if (codec === 'vacuum' || codec === 'mower') {
    return 'clean';
  }
  if (codec === 'light' || codec === 'printer') {
    return 'life';
  }
  return 'security';
}

function artworkOf(manifest: DeviceManifest): string | undefined {
  const model = manifest.model?.toUpperCase();
  if (!model?.match(/^T[A-Z0-9]+$/)) {
    return undefined;
  }
  const family =
    manifest.codec === 'vacuum' ? 'clean' : manifest.codec === 'mower' ? 'mower' : categoryOf(manifest.codec);
  return `assets/devices/${family}/${family}-${model}.png`;
}

function deviceClassOf(codec: DeviceManifest['codec']): DashboardDevice['deviceClass'] {
  const classes: Record<DeviceManifest['codec'], DashboardDevice['deviceClass']> = {
    station: 'homebase',
    camera: 'camera',
    sensor: 'sensor',
    vacuum: 'vacuum',
    mower: 'mower',
    lock: 'other',
    keypad: 'other',
    light: 'light',
    printer: 'printer',
  };
  return classes[codec];
}

function projectDevice(manifest: DeviceManifest, representationEnabled: boolean | undefined): DashboardDevice {
  const admission = describeHomeKitRepresentation(manifest);
  const represented = admission.represented && representationEnabled !== false;
  const preferences: DashboardDevice['preferences'] = admission.represented ? ['represented'] : [];
  if (admission.represented && manifest.capabilities.includes('audio')) {
    preferences.push('audio');
  }
  if (admission.represented && manifest.capabilities.includes('camera')) {
    preferences.push('snapshotMode');
  }
  return {
    serial: manifest.sn,
    name: manifest.name,
    modelName: manifest.modelName,
    category: categoryOf(manifest.codec),
    deviceClass: deviceClassOf(manifest.codec),
    recognized: true,
    represented,
    controllable: admission.controllable && represented,
    diagnosticOnly: !admission.represented,
    artwork: artworkOf(manifest),
    preferences,
  };
}

function stateOf(record: RuntimeTrackerRecord): DashboardState {
  if (record.state === 'authentication-required') {
    return 'authentication-required';
  }
  if (record.state === 'owner-conflict') {
    return 'owner-conflict';
  }
  if (record.state === 'degraded' && record.status === 'transport-degraded') {
    return 'degraded';
  }
  if (record.state === 'ready' && record.complete) {
    return 'ready';
  }
  return 'incomplete';
}

/** Projects one persisted runtime snapshot without opening an Eufy connection. */
export async function readDashboard(
  tracker: DashboardTracker,
  now: () => number = Date.now,
  representationPreferences: Readonly<Record<string, boolean>> = {},
): Promise<DashboardSnapshot> {
  const record = await tracker.read();
  if (!record) {
    return { state: 'missing', devices: [] };
  }
  const updatedAt = Date.parse(record.updatedAt);
  const age = now() - updatedAt;
  const devices =
    record.snapshot?.devices.map((manifest) => projectDevice(manifest, representationPreferences[manifest.sn])) ?? [];
  if (!Number.isFinite(updatedAt) || age < -5_000 || age > DASHBOARD_FRESH_THRESHOLD_MS) {
    return { state: 'stale', updatedAt: record.updatedAt, devices };
  }
  return { state: stateOf(record), updatedAt: record.updatedAt, devices };
}

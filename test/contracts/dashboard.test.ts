import type { DeviceManifest } from '@mega-yfue/eufy-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTrackerRecord } from '../../src/runtime/tracker.js';
import { readDashboard } from '../../src/ui/dashboard.js';

function manifest(codec: DeviceManifest['codec'], capability = 'contact'): DeviceManifest {
  return {
    sn: `synthetic-${codec}`,
    name: `Synthetic ${codec}`,
    model: codec === 'sensor' ? 'T8910' : codec === 'light' ? 'T8L00' : 'T2351',
    modelName: `Synthetic ${codec}`,
    codec,
    source: 'inferred',
    bound: true,
    capabilities: [capability] as DeviceManifest['capabilities'],
    details: [
      {
        capability,
        accessor: capability,
        reads: [
          {
            accessor: capability === 'contact' ? 'open' : 'activity',
            property: 'synthetic',
            type: capability === 'contact' ? 'bool' : 'string',
            writable: false,
          },
        ],
        actions: [],
        undescribedActions: [],
        events: [],
      },
    ],
  };
}

function record(update: Partial<RuntimeTrackerRecord> = {}): RuntimeTrackerRecord {
  return {
    version: 1,
    source: 'runtime',
    state: 'ready',
    updatedAt: '2026-08-13T12:00:00.000Z',
    complete: true,
    status: 'connected',
    snapshot: {
      version: 1,
      complete: true,
      devices: [manifest('sensor'), manifest('light', 'smart_light'), manifest('vacuum', 'vacuum_clean')],
    },
    ...update,
  };
}

describe('snapshot-driven dashboard', () => {
  it('classifies tracker fixtures without creating an SDK client', async () => {
    const now = () => Date.parse('2026-08-13T12:00:30.000Z');
    const clientFactory = vi.fn();

    await expect(readDashboard({ read: async () => record() }, now)).resolves.toMatchObject({ state: 'ready' });
    await expect(
      readDashboard(
        { read: async () => record({ state: 'degraded', status: 'transport-degraded', complete: false }) },
        now,
      ),
    ).resolves.toMatchObject({ state: 'degraded' });
    await expect(
      readDashboard(
        { read: async () => record({ state: 'degraded', status: 'incomplete-inventory', complete: false }) },
        now,
      ),
    ).resolves.toMatchObject({ state: 'incomplete' });
    await expect(
      readDashboard(
        { read: async () => record({ state: 'authentication-required', status: 'authentication-required' }) },
        now,
      ),
    ).resolves.toMatchObject({ state: 'authentication-required' });
    await expect(
      readDashboard({ read: async () => record({ state: 'owner-conflict', status: 'owner-conflict' }) }, now),
    ).resolves.toMatchObject({ state: 'owner-conflict' });
    await expect(readDashboard({ read: async () => null }, now)).resolves.toEqual({
      state: 'missing',
      devices: [],
      warmUpCandidates: [],
    });
    await expect(
      readDashboard({ read: async () => record({ updatedAt: '2026-08-13T11:57:00.000Z' }) }, now),
    ).resolves.toMatchObject({ state: 'stale' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('groups recognized devices and derives representation from admitted adapters', async () => {
    const dashboard = await readDashboard({ read: async () => record() }, () => Date.parse('2026-08-13T12:00:30.000Z'));

    expect(
      dashboard.devices.map(({ category, recognized, represented, controllable }) => ({
        category,
        recognized,
        represented,
        controllable,
      })),
    ).toEqual([
      { category: 'security', recognized: true, represented: true, controllable: false },
      { category: 'life', recognized: true, represented: false, controllable: false },
      { category: 'clean', recognized: true, represented: false, controllable: false },
    ]);
    expect(dashboard.devices.slice(1).every(({ diagnosticOnly }) => diagnosticOnly)).toBe(true);
    expect(dashboard.devices.slice(1).every(({ preferences }) => preferences.length === 0)).toBe(true);
    expect(dashboard.devices.map(({ artwork }) => artwork)).toEqual([
      'assets/devices/security/security-T8910.png',
      'assets/devices/life/life-T8L00.png',
      'assets/devices/clean/clean-T2351.png',
    ]);
  });

  it('reports an admitted device as intentionally unrepresented when its preference is disabled', async () => {
    const dashboard = await readDashboard(
      { read: async () => record({ snapshot: { version: 1, complete: true, devices: [manifest('sensor')] } }) },
      () => Date.parse('2026-08-13T12:00:30.000Z'),
      { 'synthetic-sensor': false },
    );

    expect(dashboard.devices[0]).toMatchObject({
      represented: false,
      controllable: false,
      diagnosticOnly: false,
      preferences: ['represented'],
    });
  });

  it('offers only the events HomeKit answers by asking for media', async () => {
    const camera = manifest('camera', 'motion');
    camera.details = [
      { ...camera.details[0]!, capability: 'motion', events: ['motion', 'vehicleDetected', 'cryingDetected'] },
      { ...camera.details[0]!, capability: 'doorbell', events: ['doorbellPress', 'petDetection'] },
      { ...camera.details[0]!, capability: 'person_detection', events: ['personDetected', 'strangerDetected'] },
      { ...camera.details[0]!, capability: 'battery', events: ['batteryAlert'] },
      { ...camera.details[0]!, capability: 'arming', events: ['alarm', 'armingMode'] },
      { ...camera.details[0]!, capability: 'contact', events: ['contactState'] },
    ];

    const snapshot = await readDashboard({ read: async () => record({ snapshot: { devices: [camera] } }) }, () =>
      Date.parse('2026-08-13T12:00:05.000Z'),
    );

    expect(
      snapshot.warmUpCandidates,
      'a battery alert, an arming change or a contact opening is not followed by a snapshot, so warming a connection for it only spends battery',
    ).toEqual([
      'cryingDetected',
      'doorbellPress',
      'motion',
      'personDetected',
      'petDetection',
      'strangerDetected',
      'vehicleDetected',
    ]);
  });

  it('offers nothing for a device that reports no media-triggering event', async () => {
    const snapshot = await readDashboard({ read: async () => record() }, () => Date.parse('2026-08-13T12:00:05.000Z'));

    expect(snapshot.warmUpCandidates).toEqual([]);
  });
});

import type { DeviceManifest } from '@mega-yfue/eufy-sdk';

export interface CompleteDeviceSnapshot {
  version: 1;
  complete: true;
  devices: DeviceManifest[];
}

interface DiscoveryClient {
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  getDevices(): Promise<readonly { sn: string }[]>;
  getDevice(serial: string): Promise<{ describe(): DeviceManifest }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValueArray(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((entry) => ['string', 'number'].includes(typeof entry)))
  );
}

function isLabels(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.values(value).every((label) => typeof label === 'string'));
}

function isRead(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.accessor === 'string' &&
    typeof value.property === 'string' &&
    typeof value.type === 'string' &&
    typeof value.writable === 'boolean' &&
    (value.kind === undefined || typeof value.kind === 'string') &&
    (value.unit === undefined || typeof value.unit === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    isValueArray(value.values) &&
    isLabels(value.labels)
  );
}

function isArgument(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    (value.optional === undefined || typeof value.optional === 'boolean') &&
    [value.min, value.max, value.step].every((entry) => entry === undefined || typeof entry === 'number') &&
    (value.description === undefined || typeof value.description === 'string') &&
    isValueArray(value.values) &&
    isLabels(value.labels)
  );
}

function isAction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    (value.form === 'momentary' || value.form === 'stateful') &&
    (value.reflects === undefined || typeof value.reflects === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.args === undefined || (Array.isArray(value.args) && value.args.every(isArgument)))
  );
}

function isDetail(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.capability === 'string' &&
    typeof value.accessor === 'string' &&
    Array.isArray(value.reads) &&
    value.reads.every(isRead) &&
    Array.isArray(value.actions) &&
    value.actions.every(isAction) &&
    isStringArray(value.undescribedActions) &&
    isStringArray(value.events)
  );
}

function isManifest(value: unknown): value is DeviceManifest {
  return (
    isRecord(value) &&
    typeof value.sn === 'string' &&
    typeof value.name === 'string' &&
    (value.model === undefined || typeof value.model === 'string') &&
    typeof value.modelName === 'string' &&
    typeof value.codec === 'string' &&
    typeof value.source === 'string' &&
    typeof value.bound === 'boolean' &&
    isStringArray(value.capabilities) &&
    Array.isArray(value.details) &&
    value.details.every(isDetail)
  );
}

function copyLabels(labels: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  return labels ? { ...labels } : undefined;
}

function copyManifest(manifest: DeviceManifest): DeviceManifest {
  return {
    sn: manifest.sn,
    name: manifest.name,
    model: manifest.model,
    modelName: manifest.modelName,
    codec: manifest.codec,
    source: manifest.source,
    bound: manifest.bound,
    capabilities: [...manifest.capabilities],
    details: manifest.details.map((detail) => ({
      capability: detail.capability,
      accessor: detail.accessor,
      reads: detail.reads.map((read) => ({
        accessor: read.accessor,
        property: read.property,
        type: read.type,
        kind: read.kind,
        unit: read.unit,
        values: read.values ? [...read.values] : undefined,
        labels: copyLabels(read.labels),
        writable: read.writable,
        description: read.description,
      })),
      actions: detail.actions.map((action) => ({
        name: action.name,
        form: action.form,
        reflects: action.reflects,
        args: action.args?.map((argument) => ({
          name: argument.name,
          kind: argument.kind,
          optional: argument.optional,
          min: argument.min,
          max: argument.max,
          step: argument.step,
          values: argument.values ? [...argument.values] : undefined,
          labels: copyLabels(argument.labels),
          description: argument.description,
        })),
        description: action.description,
      })),
      undescribedActions: [...detail.undescribedActions],
      events: [...detail.events],
    })),
  };
}

/** Builds the allowlisted persisted view of one complete SDK discovery. */
export function createCompleteDeviceSnapshot(manifests: readonly DeviceManifest[]): CompleteDeviceSnapshot {
  const serials = new Set<string>();
  const devices = manifests.map((manifest) => {
    if (!manifest.sn || serials.has(manifest.sn)) {
      throw new TypeError('complete device discovery contains an empty or duplicate serial');
    }
    serials.add(manifest.sn);
    return copyManifest(manifest);
  });
  return { version: 1, complete: true, devices };
}

/** Rejects malformed or incomplete persisted snapshots without treating them as device truth. */
export function parseCompleteDeviceSnapshot(value: unknown): CompleteDeviceSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Partial<CompleteDeviceSnapshot>).version !== 1 ||
    (value as Partial<CompleteDeviceSnapshot>).complete !== true ||
    !Array.isArray((value as Partial<CompleteDeviceSnapshot>).devices)
  ) {
    throw new TypeError('device snapshot is not a complete version 1 snapshot');
  }
  const snapshot = value as CompleteDeviceSnapshot;
  for (const device of snapshot.devices) {
    if (!isManifest(device)) {
      throw new TypeError('device snapshot contains a malformed manifest');
    }
  }
  return createCompleteDeviceSnapshot(snapshot.devices);
}

/** Resolves every listed device and rejects SDK evidence that the inventory was partial. */
export async function discoverCompleteDeviceSnapshot(client: DiscoveryClient): Promise<CompleteDeviceSnapshot> {
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  client.on('error', onError);
  try {
    const devices = await client.getDevices();
    const manifests: DeviceManifest[] = [];
    for (const device of devices) {
      manifests.push((await client.getDevice(device.sn)).describe());
    }
    if (errors.length > 0) {
      throw new Error('SDK reported an incomplete device discovery');
    }
    return createCompleteDeviceSnapshot(manifests);
  } finally {
    client.off('error', onError);
  }
}

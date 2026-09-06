import type { DeviceInfo } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const INFORMATION_ADAPTER_KEY = 'accessory.information';

type InformationCharacteristic =
  'Manufacturer' | 'Model' | 'SerialNumber' | 'Name' | 'FirmwareRevision' | 'HardwareRevision';

const INFORMATION_POLICY = {
  manufacturer: 'Manufacturer',
  model: 'Model',
  serialNumber: 'SerialNumber',
  name: 'Name',
  deviceType: null,
  firmwareVersion: 'FirmwareRevision',
  hardwareVersion: 'HardwareRevision',
  firmwareSubVersion: null,
  macAddress: null,
  updateAvailable: null,
} as const satisfies Record<keyof DeviceInfo, InformationCharacteristic | null>;

const REPRESENTED_INFORMATION = Object.entries(INFORMATION_POLICY).filter(
  (entry): entry is [keyof DeviceInfo, InformationCharacteristic] => entry[1] !== null,
);

/** The complete DeviceInfo surface reviewed by the plugin, including diagnostic-only members. */
export const INFORMATION_SDK_ROWS = [...Object.keys(INFORMATION_POLICY).map((member) => `info.${member}.read`)];

/** The typed SDK identity accessor consumed by HomeKit. */
export interface InformationSdkDevice {
  info?: () => DeviceInfo | undefined;
}

/** Complete registration of supplemental identity metadata in the closed HomeKit adapter set. */
export const INFORMATION_ADAPTER = {
  key: INFORMATION_ADAPTER_KEY,
  role: 'supplemental',
  requires: [],
  coverage: REPRESENTED_INFORMATION.map(([member]) => `info.${member}.read`),
  attach: attachInformation,
} as const satisfies HomeKitAdapter;

/** Attaches typed identity evidence only to an existing represented accessory container. */
function attachInformation(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const device = context.device as InformationSdkDevice;
  const info = device.info?.();
  if (!info) {
    return undefined;
  }

  const service = context.accessory.getService(context.hap.Service.AccessoryInformation)!;
  for (const [member, characteristic] of REPRESENTED_INFORMATION) {
    const value = info[member];
    if (typeof value === 'string') {
      service.updateCharacteristic(context.hap.Characteristic[characteristic], value);
    }
  }
  return {};
}

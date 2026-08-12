import type { DeviceInfo, DeviceManifest } from '@mega-yfue/eufy-sdk';

import type { AdapterAttachmentContext, AttachedAdapter, HomeKitAdapter } from '../adapter.js';

export const INFORMATION_ADAPTER_KEY = 'accessory.information';

/** The typed SDK identity accessor consumed by HomeKit. */
export interface InformationSdkDevice {
  info?: () => DeviceInfo | undefined;
}

/** Complete registration of supplemental identity metadata in the closed HomeKit adapter set. */
export const INFORMATION_ADAPTER = {
  key: INFORMATION_ADAPTER_KEY,
  role: 'supplemental',
  primaryRows: [],
  rows: [
    'info.manufacturer.read',
    'info.model.read',
    'info.serialNumber.read',
    'info.name.read',
    'info.firmwareVersion.read',
    'info.hardwareVersion.read',
  ],
  admits: (_manifest: DeviceManifest) => true,
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
  const fields = [
    ['Manufacturer', info.manufacturer],
    ['Model', info.model],
    ['SerialNumber', info.serialNumber],
    ['Name', info.name],
    ['FirmwareRevision', info.firmwareVersion],
    ['HardwareRevision', info.hardwareVersion],
  ] as const;
  for (const [characteristic, value] of fields) {
    if (value !== undefined) {
      service.updateCharacteristic(context.hap.Characteristic[characteristic], value);
    }
  }
  return {};
}

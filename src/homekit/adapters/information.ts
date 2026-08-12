import type { DeviceInfo } from '@mega-yfue/eufy-sdk';

export const INFORMATION_ADAPTER_KEY = 'accessory.information';

export interface InformationSdkDevice {
  info?: () => DeviceInfo | undefined;
}

export interface InformationRecorder {
  set(
    characteristic: 'Manufacturer' | 'Model' | 'SerialNumber' | 'Name' | 'FirmwareRevision' | 'HardwareRevision',
    value: string,
  ): void;
}

/** Enriches an existing represented accessory with typed SDK identity evidence. */
export function adaptInformation(device: InformationSdkDevice, recorder: InformationRecorder): boolean {
  const info = device.info?.();
  if (!info) {
    return false;
  }

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
      recorder.set(characteristic, value);
    }
  }
  return true;
}

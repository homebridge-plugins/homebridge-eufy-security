import { Station, Device } from 'eufy-security-client';

export interface DeviceIdentifier {
  uniqueId: string;
  displayName: string;
  type: number;
}

export interface StationContainer {
  deviceIdentifier: DeviceIdentifier;
  eufyDevice: Station;
}

export interface DeviceContainer {
  deviceIdentifier: DeviceIdentifier;
  eufyDevice: Device;
}

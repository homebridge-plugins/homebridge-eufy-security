import { PlatformConfig } from 'homebridge';

import { CameraConfig, StationConfig } from './utils/configTypes.js';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export interface EufySecurityPlatformConfig extends PlatformConfig {
  username: string;
  password: string;
  deviceName: string;
  enableDetailedLogging: boolean;
  omitLogFiles: boolean;
  CameraMaxLivestreamDuration: number;
  pollingIntervalMinutes: number;
  hkHome: number;
  hkAway: number;
  hkNight: number;
  hkOff: number;
  ignoreStations: string[];
  ignoreDevices: string[];
  country: string;
  cameras: CameraConfig[];
  stations: StationConfig[];
  cleanCache: boolean;
  ignoreMultipleDevicesWarning: boolean;
  autoSyncStation: boolean;
  enableEmbeddedPKCS1Support: boolean;
  debugLivestream: boolean;
}

export const DEFAULT_CONFIG_VALUES: EufySecurityPlatformConfig = {
  platform: 'EufySecurity',
  name: 'EufySecurity',
  username: '',
  password: '',
  deviceName: 'MyPhone',
  enableDetailedLogging: false,
  omitLogFiles: false,
  CameraMaxLivestreamDuration: 30,
  pollingIntervalMinutes: 10,
  hkHome: 1,
  hkAway: 0,
  hkNight: 3,
  hkOff: 63,
  ignoreStations: [],
  ignoreDevices: [],
  country: 'US',
  stations: [],
  cameras: [],
  cleanCache: true,
  ignoreMultipleDevicesWarning: false,
  autoSyncStation: false,
  enableEmbeddedPKCS1Support: false,
  debugLivestream: false,
};

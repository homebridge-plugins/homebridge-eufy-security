import type { PlatformPluginConstructor } from 'homebridge';

import { EufyPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface RegistrationApi {
  registerPlatform(pluginIdentifier: string, platformName: string, constructor: PlatformPluginConstructor): void;
}

export default function registerPlugin(api: RegistrationApi): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EufyPlatform);
}

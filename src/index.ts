import { API } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { EufySecurityPlatform } from './platform.js';
import { setHap } from './utils/utils.js';

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  setHap(api.hap);
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EufySecurityPlatform);
};

import { BATTERY_ADAPTER, BATTERY_ADAPTER_KEY } from './battery.js';
import { CONTACT_ADAPTER, CONTACT_ADAPTER_KEY } from './contact.js';
import { DOORBELL_ADAPTER, DOORBELL_ADAPTER_KEY } from './doorbell.js';
import { INFORMATION_ADAPTER, INFORMATION_ADAPTER_KEY } from './information.js';
import { MOTION_ADAPTER, MOTION_ADAPTER_KEY } from './motion.js';
import { SIREN_ADAPTER, SIREN_ADAPTER_KEY } from './siren.js';
import { SMART_LIGHT_ADAPTER, SMART_LIGHT_ADAPTER_KEY } from './smart-light.js';
import type { HomeKitAdapter } from '../adapter.js';

export { BATTERY_ADAPTER_KEY } from './battery.js';
export { CONTACT_ADAPTER_KEY } from './contact.js';
export { DOORBELL_ADAPTER_KEY } from './doorbell.js';
export { INFORMATION_ADAPTER_KEY } from './information.js';
export { MOTION_ADAPTER_KEY } from './motion.js';
export { SIREN_ADAPTER_KEY } from './siren.js';
export { SMART_LIGHT_ADAPTER_KEY } from './smart-light.js';

/** The closed set of adapters permitted to create HomeKit representation. */
export const ADAPTER_REGISTRY = {
  [BATTERY_ADAPTER_KEY]: BATTERY_ADAPTER,
  [CONTACT_ADAPTER_KEY]: CONTACT_ADAPTER,
  [DOORBELL_ADAPTER_KEY]: DOORBELL_ADAPTER,
  [INFORMATION_ADAPTER_KEY]: INFORMATION_ADAPTER,
  [MOTION_ADAPTER_KEY]: MOTION_ADAPTER,
  [SIREN_ADAPTER_KEY]: SIREN_ADAPTER,
  [SMART_LIGHT_ADAPTER_KEY]: SMART_LIGHT_ADAPTER,
} as const satisfies Readonly<Record<string, HomeKitAdapter>>;

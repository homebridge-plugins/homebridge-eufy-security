import { BATTERY_ADAPTER, BATTERY_ADAPTER_KEY } from './battery.js';
import { CAMERA_CONTROLS_ADAPTER, CAMERA_CONTROLS_ADAPTER_KEY } from './camera-controls.js';
import { CAMERA_STREAMING_ADAPTER, CAMERA_STREAMING_ADAPTER_KEY } from './camera-streaming.js';
import { CONTACT_ADAPTER, CONTACT_ADAPTER_KEY } from './contact.js';
import { DOORBELL_ADAPTER, DOORBELL_ADAPTER_KEY } from './doorbell.js';
import { INFORMATION_ADAPTER, INFORMATION_ADAPTER_KEY } from './information.js';
import { LOCK_ADAPTER, LOCK_ADAPTER_KEY } from './lock.js';
import { MOTION_ADAPTER, MOTION_ADAPTER_KEY } from './motion.js';
import { SECURITY_SYSTEM_ADAPTER, SECURITY_SYSTEM_ADAPTER_KEY } from './security-system.js';
import { SIREN_ADAPTER, SIREN_ADAPTER_KEY } from './siren.js';
import { SMART_LIGHT_ADAPTER, SMART_LIGHT_ADAPTER_KEY } from './smart-light.js';
import type { HomeKitAdapter } from '../adapter.js';

export { BATTERY_ADAPTER_KEY } from './battery.js';
export { CAMERA_CONTROLS_ADAPTER_KEY } from './camera-controls.js';
export { CAMERA_STREAMING_ADAPTER_KEY } from './camera-streaming.js';
export { CONTACT_ADAPTER_KEY } from './contact.js';
export { DOORBELL_ADAPTER_KEY } from './doorbell.js';
export { INFORMATION_ADAPTER_KEY } from './information.js';
export { LOCK_ADAPTER_KEY } from './lock.js';
export { MOTION_ADAPTER_KEY } from './motion.js';
export { SECURITY_SYSTEM_ADAPTER_KEY } from './security-system.js';
export { SIREN_ADAPTER_KEY } from './siren.js';
export { SMART_LIGHT_ADAPTER_KEY } from './smart-light.js';

/** The closed set of adapters permitted to create HomeKit representation. */
export const ADAPTER_REGISTRY = {
  [BATTERY_ADAPTER_KEY]: BATTERY_ADAPTER,
  [CAMERA_CONTROLS_ADAPTER_KEY]: CAMERA_CONTROLS_ADAPTER,
  [CAMERA_STREAMING_ADAPTER_KEY]: CAMERA_STREAMING_ADAPTER,
  [CONTACT_ADAPTER_KEY]: CONTACT_ADAPTER,
  [DOORBELL_ADAPTER_KEY]: DOORBELL_ADAPTER,
  [INFORMATION_ADAPTER_KEY]: INFORMATION_ADAPTER,
  [LOCK_ADAPTER_KEY]: LOCK_ADAPTER,
  [MOTION_ADAPTER_KEY]: MOTION_ADAPTER,
  [SECURITY_SYSTEM_ADAPTER_KEY]: SECURITY_SYSTEM_ADAPTER,
  [SIREN_ADAPTER_KEY]: SIREN_ADAPTER,
  [SMART_LIGHT_ADAPTER_KEY]: SMART_LIGHT_ADAPTER,
} as const satisfies Readonly<Record<string, HomeKitAdapter>>;

import { CONTACT_ADAPTER, CONTACT_ADAPTER_KEY } from './contact.js';
import { INFORMATION_ADAPTER, INFORMATION_ADAPTER_KEY } from './information.js';
import type { HomeKitAdapter } from '../adapter.js';

export { CONTACT_ADAPTER_KEY } from './contact.js';
export { INFORMATION_ADAPTER_KEY } from './information.js';

/** The closed set of adapters permitted to create HomeKit representation. */
export const ADAPTER_REGISTRY = {
  [CONTACT_ADAPTER_KEY]: CONTACT_ADAPTER,
  [INFORMATION_ADAPTER_KEY]: INFORMATION_ADAPTER,
} as const satisfies Readonly<Record<string, HomeKitAdapter>>;

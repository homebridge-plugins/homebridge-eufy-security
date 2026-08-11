import { adaptContact, CONTACT_ADAPTER_KEY } from './contact.js';

export { CONTACT_ADAPTER_KEY } from './contact.js';

/** The closed set of adapters permitted to create HomeKit representation. */
export const ADAPTER_REGISTRY = {
  [CONTACT_ADAPTER_KEY]: {
    rows: ['contact.open.read', 'contact.contactState.event'],
    attach: adaptContact,
  },
} as const;

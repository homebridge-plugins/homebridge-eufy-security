import type { DeviceManifest } from '@mega-yfue/eufy-sdk';

import { CONTACT_ADAPTER_KEY, type ContactAdapterHandle } from './contact.js';
import { INFORMATION_ADAPTER_KEY } from './information.js';

export { CONTACT_ADAPTER_KEY } from './contact.js';
export { INFORMATION_ADAPTER_KEY } from './information.js';

export interface AdapterAttachmentContext {
  contact(): ContactAdapterHandle | undefined;
  information(): boolean;
}

function admitsContact(manifest: DeviceManifest): boolean {
  return manifest.details.some(
    (detail) =>
      detail.capability === 'contact' &&
      detail.reads.some((read) => read.accessor === 'open' && read.type === 'bool' && !read.writable),
  );
}

/** The closed set of adapters permitted to create HomeKit representation. */
export const ADAPTER_REGISTRY = {
  [CONTACT_ADAPTER_KEY]: {
    role: 'primary-purpose',
    primaryRows: ['contact.open.read'],
    rows: ['contact.open.read', 'contact.contactState.event'],
    admits: admitsContact,
    attach: (context: AdapterAttachmentContext) => context.contact(),
  },
  [INFORMATION_ADAPTER_KEY]: {
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
    attach: (context: AdapterAttachmentContext) => context.information(),
  },
} as const;

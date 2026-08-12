import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { isOwnerProcessAlive } from './account/ownership.js';

export const STORAGE_DIRECTORY = 'homebridge-eufy';
const LEGACY_V5_STORAGE_DIRECTORY = 'eufy-security';

function hasLiveOwner(root: string): boolean {
  const ownershipRoot = join(root, 'ownership');
  if (!existsSync(ownershipRoot)) {
    return false;
  }
  try {
    return readdirSync(ownershipRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => {
        try {
          const record = JSON.parse(readFileSync(join(ownershipRoot, entry.name, 'owner.json'), 'utf8')) as {
            pid?: unknown;
            processIdentity?: unknown;
          };
          if (
            !Number.isInteger(record.pid) ||
            (record.pid as number) <= 0 ||
            (record.processIdentity !== undefined && typeof record.processIdentity !== 'string')
          ) {
            return true;
          }
          return isOwnerProcessAlive({
            pid: record.pid as number,
            processIdentity: record.processIdentity as string | undefined,
          });
        } catch {
          return true;
        }
      });
  } catch {
    return true;
  }
}

/** Atomically adopts the pre-rename V5 directory when no SDK owner is using it. */
export function resolveStorageRoot(homebridgeStoragePath: string): string {
  const root = join(homebridgeStoragePath, STORAGE_DIRECTORY);
  const legacyRoot = join(homebridgeStoragePath, LEGACY_V5_STORAGE_DIRECTORY);
  if (!existsSync(legacyRoot)) {
    return root;
  }
  if (existsSync(root)) {
    throw new Error(`both ${STORAGE_DIRECTORY} and ${LEGACY_V5_STORAGE_DIRECTORY} storage directories exist`);
  }
  if (hasLiveOwner(legacyRoot)) {
    return legacyRoot;
  }
  try {
    renameSync(legacyRoot, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync(root)) {
      throw error;
    }
  }
  return root;
}

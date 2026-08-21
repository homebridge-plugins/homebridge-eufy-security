/**
 * Reads and moves one camera's typed SDK enablement observation, for live acceptance only.
 *
 * `camera.enabled` is the single observation HomeKit live admission consults, and the SDK reports no
 * event when it changes, so proving the plugin's disabled-camera behavior on the wire requires actually
 * turning a camera off and on again. This tool does exactly that through the typed capability
 * (`camera.setEnabled`) and nothing else: it never touches arming, recording, or any other member.
 *
 * SAFETY, because this is a device write and a second realtime owner:
 *   - It is a maintainer tool for an approved acceptance run, never part of `npm run verify`, and never
 *     something to point at an account casually. Camera power is visible to everyone using that camera.
 *   - It works on a COPY of the persisted storage root, so it cannot rotate, stage, or invalidate the
 *     session records a running plugin owns, and it never takes the plugin's ownership lease. That also
 *     means it does not participate in the plugin's single-owner guarantee: while it runs there are two
 *     realtime owners of the same account by design, which is why it exits as soon as the write is
 *     acknowledged.
 *   - The copy is removed on close. Point `--storage` at a root the running plugin is using only if you
 *     accept a second owner for the duration.
 *
 * It prints the model and the last four characters of a serial, never a full serial, name, address, or
 * token. It requires a built `dist/`, because it reuses the plugin's own persistence rather than
 * reimplementing the record layout.
 *
 * Usage:
 *   npm run build
 *   node scripts/eufy-camera-power.mjs --storage /tmp/hb-check/homebridge-eufy --serial T8400XXXXXXXXXXX
 *   node scripts/eufy-camera-power.mjs --storage … --serial … --set off
 *   node scripts/eufy-camera-power.mjs --storage … --serial … --set on
 *
 * A successful command acknowledges delivery, not convergence: re-read with `--set` omitted to see what
 * the device reports, and expect the observation to lag a write by its own freshness window.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { options, required } from './hap-live-harness.mjs';

/** Last four characters of a serial, the only identity this tool is allowed to print. */
export function shortSerial(serial) {
  return `sn*${String(serial).slice(-4)}`;
}

/**
 * Opens one typed SDK session against a copy of a persisted storage root, exposing only the camera
 * enablement observation and its setter.
 */
export async function openCameraPower(storageRoot) {
  const root = mkdtempSync(join(tmpdir(), 'eufy-camera-power-'));
  cpSync(storageRoot, root, { recursive: true });
  const { AccountSessionPersistence } = await import('../dist/account/persistence.js').catch(() => {
    throw new Error('dist/ is missing; run npm run build before this tool');
  });
  const stores = await new AccountSessionPersistence(join(root, 'accounts')).active();
  if (!stores) {
    throw new Error('the storage root has no active account generation');
  }
  if (!stores.session.load()) {
    throw new Error('the storage root has no accepted session; authenticate in the plugin first');
  }
  const configuration = stores.configuration.load();
  const sdk = await import('@mega-yfue/eufy-sdk');
  const client = new sdk.EufyMega({
    email: stores.account,
    password: '',
    countryCode: configuration?.country,
    store: stores.session,
    pushStore: stores.push,
  });
  const login = await client.login();
  if (login.status !== 'ok') {
    throw new Error(`the persisted session did not resolve a login (${login.status})`);
  }

  const camera = async (serial) => {
    const device = await client.getDevice(serial);
    const actions = device.camera?.();
    if (!actions) {
      throw new Error(`${shortSerial(serial)} exposes no camera capability`);
    }
    return { device, actions };
  };

  return {
    /** What the device reports now, or `undefined` when it has never reported the observation. */
    async read(serial) {
      const { actions } = await camera(serial);
      return actions.enabled;
    },
    /** Issues the typed power command and returns once the SDK acknowledges its delivery. */
    async set(serial, enabled) {
      const { actions } = await camera(serial);
      if (typeof actions.setEnabled !== 'function') {
        throw new Error(`${shortSerial(serial)} exposes no enablement operation`);
      }
      await actions.setEnabled(enabled);
    },
    async close() {
      await client.disconnect().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = options(process.argv.slice(2));
  const serial = required(parsed, 'serial');
  const requested = parsed.get('set');
  const power = await openCameraPower(required(parsed, 'storage'));
  try {
    if (requested !== undefined) {
      if (requested !== 'on' && requested !== 'off') {
        throw new Error('--set accepts on or off');
      }
      await power.set(serial, requested === 'on');
      console.log(`${shortSerial(serial)} accepted power ${requested}`);
    }
    console.log(`${shortSerial(serial)} reports enabled=${await power.read(serial)}`);
  } finally {
    await power.close();
  }
}

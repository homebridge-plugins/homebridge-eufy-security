/**
 * Opens one typed SDK camera session for live acceptance, against a COPY of a persisted storage root.
 *
 * Every live tool in this directory that has to reach a device rather than the accessory needs the same
 * bootstrap, so it lives here once: resolve the active account generation, reuse the plugin's own
 * persistence rather than reimplementing its record layout, log in from the accepted session, and hand
 * back the typed camera capability.
 *
 * SAFETY, because this is a second realtime owner:
 *   - It works on a COPY of the storage root, so it cannot rotate, stage, or invalidate the session
 *     records a running plugin owns, and it never takes the plugin's ownership lease. That also means it
 *     does not participate in the plugin's single-owner guarantee: while it runs there are two realtime
 *     owners of the same account by design, so stop the instance under test first and keep the run short.
 *   - The copy is removed on close.
 *   - It requires a built `dist/`, because it reuses the plugin's own persistence.
 *
 * It prints nothing by itself. Callers print the model and at most the last four characters of a serial,
 * never a full serial, name, address, or token.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Last four characters of a serial, the only identity a live tool is allowed to print. */
export function shortSerial(serial) {
  return `sn*${String(serial).slice(-4)}`;
}

export async function openCameraSession(storageRoot) {
  const root = mkdtempSync(join(tmpdir(), 'eufy-camera-session-'));
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

  return {
    /** The typed camera capability of one device, or a refusal naming no more than a short serial. */
    async camera(serial) {
      const device = await client.getDevice(serial);
      const actions = device.camera?.();
      if (!actions) {
        throw new Error(`${shortSerial(serial)} exposes no camera capability`);
      }
      return { device, actions };
    },
    async close() {
      await client.disconnect().catch(() => undefined);
      rmSync(root, { force: true, recursive: true });
    },
  };
}

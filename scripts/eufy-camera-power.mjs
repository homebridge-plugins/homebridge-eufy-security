/**
 * Reads and moves one camera's typed SDK enablement observation, for live acceptance only.
 *
 * `camera.enabled` is the single observation HomeKit live admission consults, and the SDK reports no
 * event when it changes, so proving the plugin's disabled-camera behavior on the wire requires actually
 * turning a camera off and on again. This tool does exactly that through the typed capability
 * (`camera.setEnabled`) and nothing else: it never touches recording or any other member.
 *
 * SAFETY, because this is a device write and a second realtime owner: see `eufy-camera-session.mjs`,
 * which owns the session bootstrap and its storage-copy guarantees. Beyond those, this is a maintainer
 * tool for an approved acceptance run, never part of `npm run verify`, and never something to point at an
 * account casually. Camera power is visible to everyone using that camera.
 *
 * It prints the last four characters of a serial, never a full serial, name, address, or token.
 *
 * Usage:
 *   npm run build
 *   node scripts/eufy-camera-power.mjs --storage /tmp/hb-check/homebridge-eufy --serial T8XXXXXXXXXXXXXX
 *   node scripts/eufy-camera-power.mjs --storage … --serial … --set off
 *   node scripts/eufy-camera-power.mjs --storage … --serial … --set on
 *
 * A successful command acknowledges delivery, not convergence: re-read with `--set` omitted to see what
 * the device reports, and expect the observation to lag a write by its own freshness window.
 */
import { openCameraSession, shortSerial } from './eufy-camera-session.mjs';
import { options, required } from './hap-live-harness.mjs';

export { shortSerial };

/** Exposes only the camera enablement observation and its setter. */
export async function openCameraPower(storageRoot) {
  const session = await openCameraSession(storageRoot);
  return {
    /** What the device reports now, or `undefined` when it has never reported the observation. */
    async read(serial) {
      const { actions } = await session.camera(serial);
      return actions.enabled;
    },
    /** Issues the typed power command and returns once the SDK acknowledges its delivery. */
    async set(serial, enabled) {
      const { actions } = await session.camera(serial);
      if (typeof actions.setEnabled !== 'function') {
        throw new Error(`${shortSerial(serial)} exposes no enablement operation`);
      }
      await actions.setEnabled(enabled);
    },
    close: () => session.close(),
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

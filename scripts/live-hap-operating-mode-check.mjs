/**
 * Live qualification of the camera operating mode service.
 *
 * HomeKit presents a camera's operating mode on one service, and this plugin publishes on it only what the
 * SDK evidences: the disabled state from the camera's enablement observation, the indicator LED from its
 * status-light member, and night vision from its night-vision mode. This script reads what every camera
 * actually publishes, so a run states which cameras carry which state rather than assuming the fleet is
 * uniform — measured on one real account, all cameras published the indicator and five of eight published
 * night vision, because the other three report no mode although they offer the setter.
 *
 * With `--serial` it also qualifies the one direction that writes a device: HomeKit's own camera-active state
 * is carried through to the camera's power, so a camera the user sets to off for the mode their home is in is
 * off rather than merely unwatched. The run writes it off, waits for the camera to present itself as disabled
 * — which follows from the camera's own reading, not from what HomeKit was told — then restores it and waits
 * for the reverse. It always restores the state the camera was in when it started, including on failure.
 *
 * DEVICE WRITE, with `--serial`. Camera power is visible to everyone using that camera, so this needs
 * explicit maintainer approval, and the camera is named by serial rather than chosen here.
 *
 * The indicator LED and night vision are NOT written here. Both are timed-write characteristics: HAP itself
 * answers `-70410` to a controller that writes one without preparing the write first, before this plugin is
 * consulted, and preparing one is something the Home app does natively and this controller does not. Their
 * write paths are held by the contract suite; this script qualifies what they publish.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-stream-check.mjs`, plus a built
 * `dist/` when `--serial` is given.
 *
 * Usage:
 *   npm run build
 *   node scripts/live-hap-operating-mode-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--serial T8400XXXXXXXXXXX] [--converge-timeout 90]
 *
 * It prints models, accessory ids, and the last four characters of a serial, never a full serial, name, or
 * address, and it removes its own pairing before exiting.
 */
import {
  accessoryModel,
  cameraEnabled,
  cameraOperatingMode,
  hasBattery,
  observations,
  operatingModeAddress,
  operatingModeState,
  options,
  required,
  selectCameras,
  waitFor,
} from './hap-live-harness.mjs';

const CONVERGENCE_POLL_INTERVAL_MS = 2_000;

const parsed = options(process.argv.slice(2));
const serial = parsed.get('serial');
const convergeTimeoutMs = Number(parsed.get('converge-timeout') ?? 90) * 1_000;
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const results = observations('live camera operating mode qualification');
const check = results.check;
const short = (value) => `sn*${String(value).slice(-4)}`;

const client = new HttpClient(
  required(parsed, 'device-id'),
  required(parsed, 'address'),
  Number(required(parsed, 'port')),
  undefined,
  { usePersistentConnections: true, subscriptionsUseSameConnection: true },
);
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

/** One state read back from the accessory, coerced because HomeKit carries a boolean as 0 or 1. */
async function read(accessory, state) {
  const address = operatingModeAddress(accessory, state);
  if (!address) {
    return undefined;
  }
  const response = await client.getCharacteristics([address]);
  return Boolean(response.characteristics[0].value);
}

async function write(accessory, state, value) {
  const address = operatingModeAddress(accessory, state);
  const response = await client.setCharacteristics({ [address]: value });
  const answer = response?.[address];
  const status = answer?.characteristics?.[0]?.status ?? answer?.status;
  if (status !== undefined && status !== 0) {
    throw new Error(`the accessory refused a write to ${state} with status ${status}`);
  }
}

let target;
let originalActive;
try {
  const { accessories } = await client.getAccessories();
  const cameras = selectCameras(accessories, { battery: true });
  check(cameras.length > 0, 'the instance published at least one camera accessory');

  for (const accessory of cameras) {
    const state = await operatingModeState(client, accessory);
    const published = Object.keys(state);
    console.log(
      `aid=${accessory.aid} model="${accessoryModel(accessory)}" power=${hasBattery(accessory) ? 'battery' : 'wired'}` +
        ` ${published.map((name) => `${name}=${state[name]}`).join(' ')}`,
    );
    check(published.includes('homeKitCameraActive'), `aid=${accessory.aid} published the HomeKit camera-active state`);
    check(
      published.includes('indicator') || published.includes('nightVision'),
      `aid=${accessory.aid} published at least one state read from the camera itself`,
    );
    check(
      !cameraOperatingMode(accessory)?.characteristics.some((entry) => entry.type.toUpperCase().startsWith('00000227')),
      `aid=${accessory.aid} publishes no disabled state, which Apple Home would answer by refusing to write this service`,
    );
  }

  if (!serial) {
    results.unverified('camera-active write=not-observed (pass --serial to qualify it against one named camera)');
  } else {
    target = selectCameras(accessories, { serial })[0];
    if (!target) {
      throw new Error('no represented camera accessory reports the requested serial');
    }
    console.log(
      `\n${short(serial)} aid=${target.aid} model="${accessoryModel(target)}" accepting a camera-active write`,
    );
    originalActive = await read(target, 'homeKitCameraActive');
    check(originalActive === true, 'this check starts from a camera HomeKit is allowed to use');
    check((await cameraEnabled(client, target)) === true, 'this check starts from a camera that is powered on');

    const offFrom = Date.now();
    await write(target, 'homeKitCameraActive', false);
    const disabled = await waitFor(
      async () => (await cameraEnabled(client, target)) === false,
      convergeTimeoutMs,
      CONVERGENCE_POLL_INTERVAL_MS,
    );
    check(disabled !== undefined, `the camera reported its power off within ${convergeTimeoutMs / 1_000}s`);
    if (disabled !== undefined) {
      console.log(`reported power off ${Date.now() - offFrom}ms after HomeKit wrote camera-active off`);
    }
    check(
      (await read(target, 'homeKitCameraActive')) === false,
      'the camera-active state HomeKit wrote was not undone by a reading taken before the camera converged',
    );

    const onFrom = Date.now();
    await write(target, 'homeKitCameraActive', true);
    originalActive = undefined;
    const enabled = await waitFor(
      async () => (await cameraEnabled(client, target)) === true,
      convergeTimeoutMs,
      CONVERGENCE_POLL_INTERVAL_MS,
    );
    check(enabled !== undefined, `the camera reported its power on again within ${convergeTimeoutMs / 1_000}s`);
    if (enabled !== undefined) {
      console.log(`reported power on again ${Date.now() - onFrom}ms after HomeKit wrote camera-active on`);
    }
  }
} finally {
  if (target && originalActive !== undefined) {
    await write(target, 'homeKitCameraActive', originalActive).catch(() => undefined);
    console.log(`${short(serial)} camera-active restored to ${originalActive}`);
  }
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

results.summarize();

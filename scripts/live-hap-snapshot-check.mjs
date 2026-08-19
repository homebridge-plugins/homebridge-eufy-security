/**
 * Live HomeKit snapshot qualification.
 *
 * Pairs a real HAP controller against a running Homebridge instance, issues real HomeKit snapshot
 * resource requests for the represented cameras, and verifies the plugin's retained last successful
 * images on disk. This is the observation-only live tier of camera snapshot acceptance: it drives the
 * same path a Home app tile drives, including the SDK acquisition the plugin cannot fake.
 *
 * `npm run verify` cannot contain this check. It requires an authenticated Eufy account, reachable
 * cameras, P2P transport, and an ffmpeg binary the SDK can spawn, none of which exist in hermetic
 * contract tests. Adapter-level snapshot behavior is covered by `test/contracts/`.
 *
 * Prerequisites:
 *   1. A Homebridge instance running this plugin whose bridge is NOT paired to any controller. HAP
 *      forbids a second pair-setup, so use a dedicated instance rather than a production bridge:
 *
 *        cp -a <homebridge>/homebridge-eufy /tmp/hb-check/          # reuse the accepted session
 *        <write /tmp/hb-check/config.json with only this platform>  # unique username, port, pin
 *        node <homebridge>/node_modules/homebridge/bin/homebridge.js -U /tmp/hb-check -P <plugins> -I
 *
 *   2. `hap-controller` available without touching this repository's lockfile:
 *
 *        mkdir /tmp/hapctl && cd /tmp/hapctl && npm init -y && npm i hap-controller
 *        node scripts/live-hap-snapshot-check.mjs \
 *          --hap-controller /tmp/hapctl/node_modules/hap-controller/lib/index.js …
 *
 *      ESM ignores `NODE_PATH`, so the module is resolved from `--hap-controller` or the
 *      `HAP_CONTROLLER` environment variable, defaulting to a bare `hap-controller` specifier.
 *
 * Usage:
 *   node scripts/live-hap-snapshot-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--storage /tmp/hb-check/homebridge-eufy] [--battery] [--limit 1] [--settle-ms 25000]
 *
 * Behavior notes this check exercises:
 *   - `Refresh` with no retained image fails the first request while starting one live refresh.
 *   - A later request serves the retained image without another acquisition.
 *   - Retained files use owner-only modes and opaque serial-derived names.
 *
 * It never prints serials, device names, addresses, or image bytes, and it removes its own pairing
 * before exiting. Wired cameras are used by default because a live acquisition wakes the camera.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CAMERA_RTP_STREAM_MANAGEMENT = '00000110-0000-1000-8000-0026BB765291';
const BATTERY = '00000096-0000-1000-8000-0026BB765291';

const ACCESSORY_INFORMATION = '0000003E';
const MODEL = '00000021';

/** Product model of one accessory, which identifies a run without exposing the owner's chosen name. */
function accessoryModel(accessory) {
  const information = accessory.services.find((service) => service.type.toUpperCase().startsWith(ACCESSORY_INFORMATION));
  const model = information?.characteristics.find((entry) => entry.type.toUpperCase().startsWith(MODEL));
  return typeof model?.value === 'string' ? model.value : 'unknown model';
}

function options(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      continue;
    }
    const next = argv[index + 1];
    parsed.set(argument.slice(2), next && !next.startsWith('--') ? next : 'true');
  }
  return parsed;
}

function required(parsed, name) {
  const value = parsed.get(name);
  if (!value) {
    throw new Error(`missing --${name}; see the header of this script for usage`);
  }
  return value;
}

function retained(storage) {
  const directory = join(storage, 'snapshots');
  let names;
  try {
    names = readdirSync(directory);
  } catch (error) {
    return { readable: false, reason: error instanceof Error ? error.message : String(error), images: [] };
  }
  return {
    readable: true,
    images: names.map((name) => {
      const file = join(directory, name);
      const image = readFileSync(file);
      return {
        name,
        bytes: image.length,
        mode: (statSync(file).mode & 0o777).toString(8),
        directoryMode: (statSync(directory).mode & 0o777).toString(8),
        opaque: /^[0-9a-f]{64}\.jpg$/.test(name),
        structural: image.subarray(0, 3).toString('hex') === 'ffd8ff' && image.subarray(-2).toString('hex') === 'ffd9',
      };
    }),
  };
}

const parsed = options(process.argv.slice(2));
const settleMs = Number(parsed.get('settle-ms') ?? 25_000);
const storage = parsed.get('storage');
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const client = new HttpClient(
  required(parsed, 'device-id'),
  required(parsed, 'address'),
  Number(required(parsed, 'port')),
  undefined,
  { usePersistentConnections: true, subscriptionsUseSameConnection: true },
);
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

let failures = 0;
try {
  const { accessories } = await client.getAccessories();
  const cameras = accessories.filter((accessory) =>
    accessory.services.some((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT),
  );
  const selected = (
    parsed.has('battery')
      ? cameras
      : cameras.filter((accessory) => !accessory.services.some((service) => service.type.toUpperCase() === BATTERY))
  ).slice(0, Number(parsed.get('limit') ?? cameras.length));
  console.log(`cameras=${cameras.length} selected=${selected.length}`);
  for (const candidate of selected) {
    const powered = candidate.services.some((service) => service.type.toUpperCase() === BATTERY) ? 'battery' : 'wired';
    console.log(`  aid=${candidate.aid} model="${accessoryModel(candidate)}" power=${powered}`);
  }
  if (selected.length === 0) {
    throw new Error('no camera accessory matched the selection');
  }

  for (const { aid } of selected) {
    for (const round of [1, 2]) {
      try {
        const image = await client.getImage(1280, 720, aid);
        const digest = createHash('sha256').update(image).digest('hex').slice(0, 12);
        console.log(`aid=${aid} round=${round} served bytes=${image.length} digest=${digest}`);
      } catch (error) {
        console.log(`aid=${aid} round=${round} refused: ${error instanceof Error ? error.message : String(error)}`);
        if (round === 2) {
          failures += 1;
        }
      }
      if (round === 1) {
        await delay(settleMs);
      }
    }
  }

  if (storage) {
    const { readable, reason, images } = retained(storage);
    if (!readable) {
      throw new Error(`retained images are unreadable (${reason}); run this check as the Homebridge user`);
    }
    console.log(`retained images=${images.length}`);
    for (const image of images) {
      console.log(
        `  name-opaque=${image.opaque} directory-mode=${image.directoryMode} file-mode=${image.mode} bytes=${image.bytes} structural-jpeg=${image.structural}`,
      );
      if (!image.opaque || image.mode !== '600' || image.directoryMode !== '700' || !image.structural) {
        failures += 1;
      }
    }
    if (images.length === 0) {
      failures += 1;
    }
  }
} finally {
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

if (failures > 0) {
  console.error(`live snapshot qualification reported ${failures} failing observation(s)`);
  process.exitCode = 1;
}

/**
 * Live HomeKit codec fidelity qualification across an accessory's whole advertised matrix.
 *
 * Reads what one camera advertises in `SupportedVideoStreamConfiguration`, then negotiates one bounded
 * live session per advertised profile and level and judges the coded parameter sets read back from the
 * decrypted wire against the exact combination each session requested. It exists because the advertised
 * matrix is a promise to any controller: an accessory answers a selection without validating it, so only a
 * session per combination shows whether adaptation can honor what the plugin offers.
 *
 * What it observes, per combination:
 *   - the accessory accepts the selection and delivers authenticated video for it;
 *   - the sequence parameter sets carry exactly the requested profile and level, with Constrained Baseline
 *     as the realization of a Baseline selection, and the requested coded dimensions;
 *   - the session ends and the stream management service returns to available before the next combination
 *     is negotiated, so one combination cannot be measured through another's adaptation process.
 *
 * A combination the accessory does not advertise is never requested, and the run fails if the advertised
 * matrix is empty. Adaptation arguments are matched but never printed, because they carry SRTP key
 * material, and decrypted media is measured and discarded.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-stream-check.mjs`: a dedicated
 * Homebridge instance that is not paired to any controller, and `hap-controller` provided through
 * `--hap-controller <path>` or `HAP_CONTROLLER`.
 *
 * Usage:
 *   node scripts/live-hap-codec-matrix-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--aid 7] [--battery] [--width 1280] [--height 720] [--fps 30] [--bitrate 299] \
 *     [--all-resolutions] [--seconds 8] [--homebridge-pid 12345]
 *
 * Profile and level come from the advertisement rather than from options, so `--profile` and `--level` do
 * not apply here; `--width` and `--height` choose which advertised resolution the sweep runs at, and a
 * resolution the accessory does not advertise leaves nothing to exercise and fails the run.
 *
 * Each combination is a complete session on a cold source, so a full nine-combination run takes minutes.
 * `--all-resolutions` multiplies the matrix by every advertised resolution. A coded level is written
 * literally, including a level whose own frame-size limit the negotiated geometry exceeds, so this run
 * proves that adaptation honors the advertised matrix and never that the matrix itself is conformant.
 *
 * A live session wakes the camera, so wired cameras are used unless `--battery` is passed, and a battery
 * camera pays a source budget for every combination.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  ENDPOINTS_ACCEPTED,
  LiveSession,
  STREAMING_AVAILABLE,
  accessoryModel,
  adaptationProcesses,
  advertisedVideo,
  hasBattery,
  judgeWindow,
  measuredWindow,
  observations,
  options,
  reportAdvertisedVideo,
  required,
  selectCameras,
  videoSelection,
  waitFor,
} from './hap-live-harness.mjs';

const FIRST_PACKET_TIMEOUT_MS = 25_000;
const TEARDOWN_GRACE_MS = 5_000;

const parsed = options(process.argv.slice(2));
const address = required(parsed, 'address');
const seconds = Number(parsed.get('seconds') ?? 8);
const requested = videoSelection(parsed);
const homebridgePid = parsed.get('homebridge-pid');
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const results = observations('live codec matrix qualification');
const check = results.check;

/**
 * Every combination this run will request: each advertised profile with each advertised level, at the one
 * resolution the options select or at every advertised resolution. A resolution is taken from the
 * advertisement so its frame rate is the advertised one rather than a rate this run assumed.
 */
function combinations(configurations) {
  const selections = [];
  for (const configuration of configurations.filter((entry) => entry.codec === 'h264')) {
    const resolutions = parsed.has('all-resolutions')
      ? configuration.resolutions
      : configuration.resolutions.filter(
          (resolution) => resolution.width === requested.width && resolution.height === requested.height,
        );
    for (const resolution of resolutions) {
      for (const profile of configuration.profiles) {
        for (const level of configuration.levels) {
          selections.push({
            ...requested,
            width: resolution.width,
            height: resolution.height,
            fps: Math.min(requested.fps, resolution.fps),
            profile,
            level,
          });
        }
      }
    }
  }
  return selections;
}

/** One bounded session for one combination, judged on what it coded rather than on what it was asked. */
async function exercise(client, accessory, selection) {
  const label = `${selection.profile}@${selection.level} ${selection.width}x${selection.height}@${selection.fps}`;
  const session = new LiveSession(client, accessory, address);
  const endpoints = await session.setup();
  if (endpoints.status !== ENDPOINTS_ACCEPTED) {
    session.close();
    check(false, `${label} was accepted for endpoint setup`);
    return { label, coded: `endpoint setup refused with status ${endpoints.status}` };
  }
  let coded = 'no video arrived';
  try {
    const startedAt = Date.now();
    await session.start(selection);
    const firstPacket = await waitFor(() => session.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
    check(firstPacket !== undefined, `${label} delivered video within ${FIRST_PACKET_TIMEOUT_MS / 1_000}s`);
    if (firstPacket !== undefined) {
      console.log(`${label} first video packet after ${Date.now() - startedAt}ms`);
      const early = session.measured.report;
      const observedFrom = Date.now();
      await delay(seconds * 1_000);
      const report = session.measured.report;
      judgeWindow(results, {
        label,
        window: measuredWindow(report, early),
        seconds: (Date.now() - observedFrom) / 1_000,
        expected: selection,
        session: report,
        samples: session.samplesSince(observedFrom),
      });
      coded = report.parameterSets.map((set) => `${set.width}x${set.height} ${set.profile}@${set.level}`).join(' -> ');
    }
    await session.end();
  } finally {
    session.close();
  }
  await delay(TEARDOWN_GRACE_MS);
  const processes = adaptationProcesses(homebridgePid);
  if (processes !== undefined) {
    check(processes.length === 0, `${label} left no adaptation process behind`);
  }
  check((await session.streamingStatus()) === STREAMING_AVAILABLE, `${label} returned to an available status`);
  return { label, coded };
}

const client = new HttpClient(required(parsed, 'device-id'), address, Number(required(parsed, 'port')), undefined, {
  usePersistentConnections: true,
  subscriptionsUseSameConnection: true,
});
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

try {
  const { accessories } = await client.getAccessories();
  const cameras = selectCameras(accessories, {
    battery: parsed.has('battery'),
    ...(parsed.has('aid') ? { aid: parsed.get('aid') } : {}),
  });
  const accessory = cameras[0];
  if (!accessory) {
    throw new Error('no camera accessory matched the selection');
  }
  console.log(
    `camera aid=${accessory.aid} model="${accessoryModel(accessory)}"` +
      ` power=${hasBattery(accessory) ? 'battery' : 'wired'}`,
  );

  const advertised = await advertisedVideo(client, accessory);
  reportAdvertisedVideo(advertised);
  const matrix = combinations(advertised);
  check(
    matrix.length > 0,
    `the accessory advertised a combination at ${requested.width}x${requested.height} this run could request`,
  );
  console.log(`exercising ${matrix.length} advertised combination(s)`);

  const observed = [];
  for (const selection of matrix) {
    observed.push(await exercise(client, accessory, selection));
  }
  console.log('requested -> coded');
  for (const entry of observed) {
    console.log(`  ${entry.label} -> ${entry.coded}`);
  }
} finally {
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

results.summarize();

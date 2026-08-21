/**
 * Live HomeKit qualification of a disabled camera.
 *
 * A camera that is turned off has no video to give. The plugin therefore refuses a live session for it at
 * `SetupEndpoints`, which is the only refusal point HAP offers, and ends an active session when its
 * admitted enablement observation later reads disabled, instead of letting a viewer watch nothing. This
 * script proves both on the wire, in one pairing, against a real camera:
 *
 *   1. a session streams while the camera is enabled;
 *   2. turning the camera off ends that session, releases its adaptation, and returns the accessory to an
 *      available streaming status, with the plugin recording the bounded refusal reason and NO media
 *      failure reason — which is what distinguishes the gate firing from the source dying;
 *   3. a new session is refused while the camera stays off, opening no transport at all;
 *   4. snapshots stay reachable while the camera is off, because presentation for a disabled camera lives
 *      on the snapshot path rather than behind the stream management `Active` characteristic;
 *   5. turning the camera back on admits a session again, and the delay before it does is measured rather
 *      than assumed.
 *
 * The detection delay in step 2 is a property of the SDK's observation freshness, not of the plugin: the
 * SDK reports no event when a camera is switched off, so the plugin re-reads the observation while a
 * session is active and can only act once that read changes. This script measures that delay; it does not
 * assert a bound on it, because the bound belongs to whatever the measurement shows.
 *
 * DEVICE WRITE. Unlike every other live script here, this one turns a real camera off and on again
 * through the typed SDK, so it needs explicit maintainer approval and a camera named by serial. It always
 * restores the state the camera was in when it started, including on failure. See
 * `eufy-camera-power.mjs` for the safety properties of that write, notably that it is a second realtime
 * owner of the account while it runs.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-stream-check.mjs`, plus a
 * built `dist/` and read access to the plugin's storage root.
 *
 * Usage:
 *   npm run build
 *   node scripts/live-hap-disabled-camera-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     --serial T8400XXXXXXXXXXX --eufy-storage /tmp/hb-check/homebridge-eufy \
 *     [--seconds 15] [--detect-timeout 180] [--admit-timeout 180] [--homebridge-pid 12345] \
 *     [--instance-log /tmp/hb-check/instance.log]
 *
 * It prints a model and the last four characters of the serial it was given, never a full serial, name,
 * address, image, or log line, and it removes its own pairing before exiting.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { openCameraPower, shortSerial } from './eufy-camera-power.mjs';
import {
  ENDPOINTS_ACCEPTED,
  LiveSession,
  STREAMING_AVAILABLE,
  STREAMING_IN_USE,
  accessoryModel,
  adaptationProcesses,
  advertisedVideo,
  appendedLines,
  conditionCodes,
  hasBattery,
  judgeWindow,
  logMark,
  measuredWindow,
  observations,
  options,
  refuseUnadvertised,
  reportAdvertisedVideo,
  required,
  selectCameras,
  snapshotImage,
  videoSelection,
  waitFor,
} from './hap-live-harness.mjs';

const FIRST_PACKET_TIMEOUT_MS = 20_000;
const TEARDOWN_GRACE_MS = 5_000;
const STATUS_POLL_INTERVAL_MS = 1_000;
const ADMISSION_POLL_INTERVAL_MS = 5_000;
const REFUSAL_CONDITION = 'camera-live-session-refused';
const FAILURE_CONDITION = 'camera-live-session-failed';

const parsed = options(process.argv.slice(2));
const address = required(parsed, 'address');
const serial = required(parsed, 'serial');
const seconds = Number(parsed.get('seconds') ?? 15);
const detectTimeoutMs = Number(parsed.get('detect-timeout') ?? 180) * 1_000;
const admitTimeoutMs = Number(parsed.get('admit-timeout') ?? 180) * 1_000;
const homebridgePid = parsed.get('homebridge-pid');
const selection = videoSelection(parsed);
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const results = observations('live disabled-camera qualification');
const check = results.check;

/** Adaptation processes the plugin owns, never printing their arguments, which carry SRTP key material. */
function observeAdaptation(label, expectedCount) {
  const processes = adaptationProcesses(homebridgePid);
  if (processes === undefined) {
    results.unverified(`${label} adaptation processes=not-observed (pass --homebridge-pid to verify them)`);
    return;
  }
  console.log(`${label} adaptation processes=${processes.length}`);
  check(processes.length === expectedCount, `${label} ran exactly ${expectedCount} adaptation process(es)`);
}

/**
 * Judges the conditions the plugin recorded for this run by code alone. The refusal code proves the gate
 * acted; the absence of the media failure code proves the session was not simply starved of frames.
 */
function judgeConditions(mark) {
  if (!mark) {
    results.unverified(`instance-log=not-observed (pass --instance-log to verify ${REFUSAL_CONDITION})`);
    return;
  }
  const codes = conditionCodes(appendedLines(mark));
  console.log(`instance-log conditions=[${[...codes].join(',')}]`);
  check(codes.has(REFUSAL_CONDITION), `the plugin recorded ${REFUSAL_CONDITION} for the disabled camera`);
  check(!codes.has(FAILURE_CONDITION), `the plugin recorded no ${FAILURE_CONDITION}, so the gate ended the session`);
}

/**
 * One snapshot request, reported by size and digest only. Returns nothing when the accessory refused it,
 * which a caller must interpret against a baseline: a camera whose acquisition never succeeds says nothing
 * about what being disabled changed.
 */
async function snapshot(accessory, label) {
  try {
    const served = await snapshotImage(client, accessory.aid);
    console.log(`snapshot ${label} bytes=${served.bytes} digest=${served.digest}`);
    return served;
  } catch (error) {
    console.log(`snapshot ${label} refused: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const power = await openCameraPower(required(parsed, 'eufy-storage'));
const originallyEnabled = await power.read(serial);
console.log(`${shortSerial(serial)} reports enabled=${originallyEnabled} before the run`);
if (originallyEnabled !== true) {
  await power.close();
  throw new Error('this check starts from an enabled camera, so it can restore exactly what it changed');
}

const client = new HttpClient(required(parsed, 'device-id'), address, Number(required(parsed, 'port')), undefined, {
  usePersistentConnections: true,
  subscriptionsUseSameConnection: true,
});
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

const sessions = [];
const instanceLog = logMark(parsed.get('instance-log'));
try {
  const { accessories } = await client.getAccessories();
  const accessory = selectCameras(accessories, { serial })[0];
  if (!accessory) {
    throw new Error('no represented camera accessory reports the requested serial');
  }
  console.log(
    `camera aid=${accessory.aid} model="${accessoryModel(accessory)}" ${shortSerial(serial)}` +
      ` power=${hasBattery(accessory) ? 'battery' : 'wired'}`,
  );
  const advertised = await advertisedVideo(client, accessory);
  reportAdvertisedVideo(advertised);
  refuseUnadvertised(advertised, selection, 'selection');

  const streaming = new LiveSession(client, accessory, address);
  sessions.push(streaming);
  const endpoints = await streaming.setup();
  if (endpoints.status !== ENDPOINTS_ACCEPTED) {
    throw new Error(`the enabled camera refused endpoint setup with status ${endpoints.status}`);
  }
  await streaming.start(selection);
  const firstPacket = await waitFor(() => streaming.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
  check(firstPacket !== undefined, 'the enabled camera streamed before the camera was turned off');
  const enabledSnapshot = await snapshot(accessory, 'while enabled');
  const early = streaming.measured.report;
  const observedFrom = Date.now();
  await delay(seconds * 1_000);
  const established = streaming.measured.report;
  judgeWindow(results, {
    label: 'enabled',
    window: measuredWindow(established, early),
    seconds: (Date.now() - observedFrom) / 1_000,
    expected: selection,
    session: established,
  });
  observeAdaptation('enabled', 1);

  console.log(`${shortSerial(serial)} accepting power off`);
  const disabledAt = Date.now();
  await power.set(serial, false);
  console.log(`${shortSerial(serial)} power off acknowledged after ${Date.now() - disabledAt}ms`);

  const ended = await waitFor(
    async () => (await streaming.streamingStatus()) === STREAMING_AVAILABLE,
    detectTimeoutMs,
    STATUS_POLL_INTERVAL_MS,
  );
  const detectedMs = Date.now() - disabledAt;
  check(ended !== undefined, `the plugin ended the session within ${detectTimeoutMs / 1_000}s of the camera going off`);
  if (ended !== undefined) {
    console.log(`session ended ${detectedMs}ms after the power-off command was acknowledged`);
    const stopped = streaming.measured.report;
    await delay(TEARDOWN_GRACE_MS);
    check(
      streaming.measured.report.packets === stopped.packets,
      'no further video arrived once the session had been ended',
    );
    observeAdaptation('after-disable', 0);
  }

  const refused = new LiveSession(client, accessory, address);
  sessions.push(refused);
  const refusal = await refused.setup();
  console.log(`endpoint setup while disabled returned status ${refusal.status}`);
  check(refusal.status !== ENDPOINTS_ACCEPTED, 'the accessory refused endpoint setup while the camera was off');
  check(
    (await refused.streamingStatus()) === STREAMING_AVAILABLE,
    'a refused setup left the stream management available rather than reserved',
  );
  observeAdaptation('refused', 0);

  const disabledSnapshot = await snapshot(accessory, 'while disabled');
  if (enabledSnapshot === undefined) {
    results.unverified(
      'snapshot reachability while disabled=not-observed (this camera does not serve a snapshot when enabled either)',
    );
  } else {
    check(disabledSnapshot !== undefined, 'the snapshot path stayed reachable while the camera was off');
  }

  console.log(`${shortSerial(serial)} accepting power on`);
  const enabledAt = Date.now();
  await power.set(serial, true);
  let admitted;
  const readmitted = await waitFor(
    async () => {
      const candidate = new LiveSession(client, accessory, address);
      const answer = await candidate.setup();
      if (answer.status === ENDPOINTS_ACCEPTED) {
        admitted = candidate;
        sessions.push(candidate);
        return true;
      }
      candidate.close();
      return false;
    },
    admitTimeoutMs,
    ADMISSION_POLL_INTERVAL_MS,
  );
  check(readmitted !== undefined, `the plugin admitted a session again within ${admitTimeoutMs / 1_000}s`);
  if (admitted) {
    console.log(`session admitted again ${Date.now() - enabledAt}ms after the power-on command`);
    await admitted.start(selection);
    const restored = await waitFor(() => admitted.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
    check(restored !== undefined, 'the re-enabled camera streamed again');
    check((await admitted.streamingStatus()) === STREAMING_IN_USE, 'the re-admitted session reported an in-use status');
    await admitted.end();
    await delay(TEARDOWN_GRACE_MS);
    observeAdaptation('after-end', 0);
  }

  judgeConditions(instanceLog);
} finally {
  for (const session of sessions) {
    session.close();
  }
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
  try {
    await power.set(serial, originallyEnabled);
    console.log(`${shortSerial(serial)} restored to enabled=${originallyEnabled}`);
  } finally {
    await power.close();
  }
}

results.summarize();

/**
 * Live HomeKit qualification of a disabled camera.
 *
 * A camera that is turned off has no video to give. The plugin therefore presents it to HomeKit as
 * disabled, refuses a live session for it at `SetupEndpoints`, which is the only refusal point HAP offers,
 * and ends an active session when its admitted enablement observation later reads disabled, instead of
 * letting a viewer watch nothing. This script proves all three on the wire, in one pairing, against a real
 * camera:
 *
 *   1. a session streams while the camera is enabled, and the accessory presents it as not disabled;
 *   2. turning the camera off ends that session, releases its adaptation, and returns the accessory to an
 *      available streaming status, with the plugin recording the bounded refusal reason and NO media
 *      failure reason — which is what distinguishes the gate firing from the source dying;
 *   3. the accessory then presents the camera as disabled on its Camera Operating Mode service, which is
 *      what stops Apple Home offering a tile whose stream would only be refused. What Apple Home renders
 *      from that state is not observable here and stays a human check;
 *   4. a new session is refused while the camera stays off, opening no transport at all. Only HAP's `ERROR`
 *      status proves the gate: a `BUSY` answer means a session was still holding that stream management
 *      service and proves nothing, so it is reported as unverified rather than as a pass;
 *   5. snapshots stay reachable while the camera is off, because presentation for a disabled camera lives
 *      on the snapshot path rather than behind the stream management `Active` characteristic;
 *   6. turning the camera back on admits a session again and presents it as not disabled again, and the
 *      delay before each is measured rather than assumed.
 *
 * The detection delay is a property of how the change reaches the plugin, not of the gate: this run's write
 * is issued by a second SDK client, so the plugin learns it either from the SDK's generic property
 * announcement or from its own supervision read, never from the write confirmation a write of its own would
 * announce. Which of the two acted is printed rather than asserted, because either satisfies the gate and
 * the measured delay cannot tell them apart. The delay is measured; no bound is asserted, because the bound
 * belongs to whatever the measurement shows.
 *
 * `--instance-log` and `--jsonl` are read for different facts and neither substitutes for the other. The
 * Homebridge instance log carries one printed `[code]` line per condition, which is what proves a gate acted
 * and that no media failure did. The reason behind a code, and the announcement trace that names the path,
 * exist only as records in the plugin's own JSONL log, because an instance-log line is prefixed with a
 * timestamp and is therefore not a record. Without `--jsonl` this run cannot separate the mid-session gate
 * from the `SetupEndpoints` refusal that follows it, and says so rather than passing on the shared code.
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
 *     [--instance-log /tmp/hb-check/instance.log] \
 *     [--jsonl /tmp/hb-check/homebridge-eufy/logs/homebridge-eufy.jsonl]
 *
 * It prints a model and the last four characters of the serial it was given, never a full serial, name,
 * address, image, or log line, and it removes its own pairing before exiting.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { openCameraPower, shortSerial } from './eufy-camera-power.mjs';
import {
  ENDPOINTS_ACCEPTED,
  ENDPOINTS_BUSY,
  ENDPOINTS_REFUSED,
  LiveSession,
  STREAMING_AVAILABLE,
  STREAMING_IN_USE,
  accessoryModel,
  adaptationProcesses,
  adaptationProcessRoles,
  advertisedVideo,
  announcedEnablement,
  appendedLines,
  conditionCodes,
  hasBattery,
  judgeWindow,
  logMark,
  measuredWindow,
  observations,
  cameraEnabled,
  options,
  raisedConditions,
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
const MID_SESSION_REASON = 'disabled-mid-session';

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

/**
 * Adaptation processes the plugin owns, judged by role rather than by a raw count, because a session that
 * negotiates audio legitimately runs a second process for it. Arguments are never printed: they carry SRTP
 * key material.
 */
function observeAdaptation(label, { video, audio }) {
  const processes = adaptationProcesses(homebridgePid);
  if (processes === undefined) {
    results.unverified(`${label} adaptation processes=not-observed (pass --homebridge-pid to verify them)`);
    return;
  }
  const roles = adaptationProcessRoles(processes);
  console.log(
    `${label} adaptation processes=${processes.length}` +
      ` video=${roles.video.length} audio=${roles.audio.length} return-audio=${roles.returnAudio.length}` +
      ` other=${roles.other.length}`,
  );
  check(
    roles.video.length === video && roles.audio.length === audio && roles.other.length === 0,
    `${label} ran exactly ${video} outbound video and ${audio} outbound audio adaptation(s)`,
  );
}

/**
 * Judges the conditions the plugin recorded for this run. The refusal code proves a gate acted at all and
 * the absence of the media failure code proves the session was not simply starved of frames; both are read
 * from the instance log's printed condition lines, so a host without the plugin's JSONL log still answers
 * them.
 *
 * Which gate acted needs the reason rather than the code, and the reason is only in the JSONL records:
 * this run legitimately refuses twice under one code, once mid-session and once at the `SetupEndpoints`
 * that follows, so a code-only judgement passes on the second even when the mid-session gate never fired,
 * which is the single claim this run exists to establish. Required exactly once, because a second would
 * mean the supervision read kept firing at sessions it had already ended.
 */
function judgeConditions(instanceMark, pluginMark) {
  if (instanceMark) {
    const codes = conditionCodes(appendedLines(instanceMark));
    console.log(`instance-log conditions=[${[...codes].join(',')}]`);
    check(codes.has(REFUSAL_CONDITION), `the plugin recorded ${REFUSAL_CONDITION} for the disabled camera`);
    check(!codes.has(FAILURE_CONDITION), `the plugin recorded no ${FAILURE_CONDITION}, so the gate ended the session`);
  } else {
    results.unverified(`instance-log=not-observed (pass --instance-log to verify ${REFUSAL_CONDITION})`);
  }
  if (!pluginMark) {
    results.unverified(`condition reasons=not-observed (pass --jsonl to verify ${MID_SESSION_REASON})`);
    return;
  }
  const conditions = raisedConditions(pluginMark);
  console.log(`plugin-log reasons=[${conditions.map(({ code, reason }) => `${code}:${reason}`).join(',')}]`);
  check(
    conditions.filter(({ code, reason }) => code === REFUSAL_CONDITION && reason === MID_SESSION_REASON).length === 1,
    `the plugin recorded ${MID_SESSION_REASON} exactly once, so the mid-session gate ended the session`,
  );
}

/**
 * Which inbound path the plugin learned the change on, recorded rather than required.
 *
 * The plugin ends the session both from an announced change and from its own supervision read, and the
 * measured delay alone cannot tell them apart. This run's write is issued by a second SDK client, so an
 * announcement here is the SDK's generic property announcement (`poll`) rather than the write confirmation
 * (`write`) a write of the plugin's own would produce, and a section that carries the refusal but no
 * announcement is one the supervision read ended. Anchored on that refusal so a log this run never read
 * cannot be mistaken for one in which nothing was announced, and read while only the power-off change has
 * been announced, because the power-on later in this run announces on the same trace.
 */
function reportEnablementPath(mark) {
  const announced = mark ? announcedEnablement(mark, MID_SESSION_REASON) : undefined;
  if (announced === undefined) {
    results.unverified(
      `enablement change path=not-observed (needs a --jsonl section carrying ${MID_SESSION_REASON} to name the path that acted)`,
    );
    return;
  }
  console.log(
    announced.length === 0
      ? 'enablement change announced=none, so the supervision read is what ended the session'
      : `enablement change announced=[${announced.map(({ adapter, announcedBy }) => `${adapter}/${announcedBy}`).join(',')}]`,
  );
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
const pluginLog = logMark(parsed.get('jsonl'));
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
  check((await cameraEnabled(client, accessory)) === true, 'the enabled camera reported its power on to HomeKit');
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
    samples: streaming.samplesSince(observedFrom),
  });
  observeAdaptation('enabled', { video: 1, audio: 1 });

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
  reportEnablementPath(pluginLog);
  if (ended !== undefined) {
    console.log(`session ended ${detectedMs}ms after the power-off command was acknowledged`);
    const stopped = streaming.measured.report;
    await delay(TEARDOWN_GRACE_MS);
    check(
      streaming.measured.report.packets === stopped.packets,
      'no further video arrived once the session had been ended',
    );
    observeAdaptation('after-disable', { video: 0, audio: 0 });
  }

  const presented = await waitFor(
    async () => (await cameraEnabled(client, accessory)) === false,
    detectTimeoutMs,
    STATUS_POLL_INTERVAL_MS,
  );
  check(presented !== undefined, 'the accessory reported the switched-off camera as powered off to HomeKit');
  if (presented !== undefined) {
    console.log(`reported power off ${Date.now() - disabledAt}ms after the power-off command was acknowledged`);
  }

  const refused = new LiveSession(client, accessory, address);
  sessions.push(refused);
  const refusal = await refused.setup();
  console.log(`endpoint setup while disabled returned status ${refusal.status}`);
  check(
    refusal.status === ENDPOINTS_REFUSED,
    'the accessory answered endpoint setup with an error while the camera was off',
  );
  if (refusal.status === ENDPOINTS_BUSY) {
    results.unverified(
      'the refusal was answered BUSY, so a session still held that stream management service and nothing was proven',
    );
  }
  check(
    (await refused.streamingStatus()) === STREAMING_AVAILABLE,
    'a refused setup left the stream management available rather than reserved',
  );
  observeAdaptation('refused', { video: 0, audio: 0 });

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
  check(
    (await cameraEnabled(client, accessory)) === true,
    'the re-enabled camera reported its power on to HomeKit again',
  );
  if (admitted) {
    console.log(`session admitted again ${Date.now() - enabledAt}ms after the power-on command`);
    await admitted.start(selection);
    const restored = await waitFor(() => admitted.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
    check(restored !== undefined, 'the re-enabled camera streamed again');
    check((await admitted.streamingStatus()) === STREAMING_IN_USE, 'the re-admitted session reported an in-use status');
    await admitted.end();
    await delay(TEARDOWN_GRACE_MS);
    observeAdaptation('after-end', { video: 0, audio: 0 });
  }

  judgeConditions(instanceLog, pluginLog);
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

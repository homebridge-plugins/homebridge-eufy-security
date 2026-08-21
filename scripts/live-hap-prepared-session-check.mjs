/**
 * Live qualification of a prepared live session that never starts.
 *
 * A controller writes `SetupEndpoints` before it decides whether to start a session, so the accessory
 * answers with reserved ports that may never be used. This script drives that exact case against a
 * running Homebridge instance and observes what the reservation costs, how long it survives, and what
 * releases it. It exists because the answer is a property of HAP session ownership and of the plugin's
 * cleanup paths, neither of which a hermetic contract can measure end to end.
 *
 * What it observes:
 *   - `SetupEndpoints` succeeds and the answered accessory video port is really bound on this host;
 *   - the prepared session reports an in-use streaming status, refuses a second setup on the same stream
 *     management service, and leaves the camera's other service free to negotiate;
 *   - no adaptation process exists for the whole idle window, so a prepared session costs reservations
 *     only and holds no source, process, or device session;
 *   - nothing in the plugin releases the reservation while the session is idle, however long the wait;
 *   - a start written after that whole idle window still streams, so the answer stayed valid;
 *   - an explicit end on a prepared session that never started releases its reservation;
 *   - closing the controller's HAP connection releases a prepared session's reservation and returns the
 *     stream management service to available;
 *   - a start written for a session the accessory has released is refused at the characteristic rather
 *     than accepted against nothing.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-stream-check.mjs`: use a
 * dedicated Homebridge instance that is not paired to any controller, and provide `hap-controller`
 * through `--hap-controller <path>` or `HAP_CONTROLLER`. Adaptation arguments are counted but never
 * printed, because they carry SRTP key material.
 *
 * Usage:
 *   node scripts/live-hap-prepared-session-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--aid 7] [--battery] [--idle-seconds 120] [--stream-seconds 10] \
 *     [--width 1280] [--height 720] [--fps 30] [--bitrate 299] [--profile main] [--level 3.1] \
 *     [--homebridge-pid 12345]
 *
 * The idle window is the measurement: pass an `--idle-seconds` longer than any bound the plugin could
 * plausibly hold, and the late start proves whether the negotiation survived it.
 */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ENDPOINTS_ACCEPTED,
  ENDPOINTS_BUSY,
  LiveSession,
  STREAMING_AVAILABLE,
  STREAMING_IN_USE,
  accessoryModel,
  adaptationProcesses,
  advertisedVideo,
  cameraStreamManagements,
  hasBattery,
  observations,
  options,
  refuseUnadvertised,
  reportAdvertisedVideo,
  required,
  selectCameras,
  videoSelection,
  waitFor,
} from './hap-live-harness.mjs';

const FIRST_PACKET_TIMEOUT_MS = 25_000;
const RELEASE_GRACE_MS = 3_000;
const IDLE_POLL_MS = 15_000;

const parsed = options(process.argv.slice(2));
const address = required(parsed, 'address');
const idleSeconds = Number(parsed.get('idle-seconds') ?? 120);
const streamSeconds = Number(parsed.get('stream-seconds') ?? 10);
const selection = videoSelection(parsed);
const homebridgePid = parsed.get('homebridge-pid');
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const results = observations('prepared session qualification');
const check = results.check;

/** UDP ports bound on this host, which is where a media port reservation is visible. */
function boundUdpPorts() {
  try {
    return new Set(
      execFileSync('ss', ['-H', '-u', '-a', '-n'], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[3] ?? '')
        .map((local) => Number(local.slice(local.lastIndexOf(':') + 1)))
        .filter((port) => Number.isInteger(port) && port > 0),
    );
  } catch {
    return undefined;
  }
}

/**
 * Judges whether the port the accessory answered with is reserved. A released port may in principle be
 * taken by another process before the next observation, which would report it as still reserved, so this
 * observation is only ever used to confirm an expectation the streaming status already agrees with.
 */
function observeReservation(label, port, expected) {
  const ports = boundUdpPorts();
  if (!ports) {
    results.unverified(`${label} reservation=not-observed (ss is unavailable)`);
    return;
  }
  console.log(`${label} accessory-video-port-reserved=${ports.has(port)}`);
  check(
    ports.has(port) === expected,
    `${label} ${expected ? 'reserved the answered accessory video port' : 'released the answered accessory video port'}`,
  );
}

/** Adaptation processes the plugin owns, counted only, because their arguments carry SRTP keys. */
function observeAdaptation(label, expectedCount) {
  const processes = adaptationProcesses(homebridgePid);
  if (processes === undefined) {
    results.unverified(`${label} adaptation processes=not-observed (pass --homebridge-pid to verify them)`);
    return;
  }
  console.log(`${label} adaptation processes=${processes.length}`);
  check(processes.length === expectedCount, `${label} ran exactly ${expectedCount} adaptation process(es)`);
}

const client = new HttpClient(required(parsed, 'device-id'), address, Number(required(parsed, 'port')), undefined, {
  usePersistentConnections: true,
  subscriptionsUseSameConnection: true,
});
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

const sessions = [];
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
  const streamCount = cameraStreamManagements(accessory).length;
  console.log(
    `camera aid=${accessory.aid} model="${accessoryModel(accessory)}"` +
      ` power=${hasBattery(accessory) ? 'battery' : 'wired'} stream-managements=${streamCount}`,
  );
  const advertised = await advertisedVideo(client, accessory);
  reportAdvertisedVideo(advertised);
  refuseUnadvertised(advertised, selection, 'selection');

  console.log(`idle prepared session, holding ${idleSeconds}s without a start`);
  const idle = new LiveSession(client, accessory, address);
  sessions.push(idle);
  const endpoints = await idle.setup();
  if (endpoints.status !== ENDPOINTS_ACCEPTED) {
    throw new Error(`accessory refused endpoint setup with status ${endpoints.status}`);
  }
  console.log(`endpoints accepted accessory-video-port=${endpoints.accessoryVideoPort}`);
  observeReservation('prepared', endpoints.accessoryVideoPort, true);
  check(
    (await idle.streamingStatus()) === STREAMING_IN_USE,
    'the prepared session reported an in-use streaming status',
  );
  observeAdaptation('prepared', 0);

  const contending = new LiveSession(client, accessory, address);
  sessions.push(contending);
  check(
    (await contending.setup()).status === ENDPOINTS_BUSY,
    'a second setup on the held stream management service was refused as busy',
  );
  if (streamCount > 1) {
    const spare = new LiveSession(client, accessory, address, { streamIndex: 1 });
    sessions.push(spare);
    const spareEndpoints = await spare.setup();
    check(
      spareEndpoints.status === ENDPOINTS_ACCEPTED,
      "the camera's other stream management service still negotiated",
    );
    if (spareEndpoints.status === ENDPOINTS_ACCEPTED) {
      await spare.end();
      await delay(RELEASE_GRACE_MS);
      observeReservation('ended-without-start', spareEndpoints.accessoryVideoPort, false);
      check(
        (await spare.streamingStatus()) === STREAMING_AVAILABLE,
        'an explicit end released a prepared session that never started',
      );
    }
  }

  const idleFrom = Date.now();
  while ((Date.now() - idleFrom) / 1_000 < idleSeconds) {
    await delay(Math.min(IDLE_POLL_MS, Math.max(idleSeconds * 1_000 - (Date.now() - idleFrom), 0)));
    const elapsed = Math.round((Date.now() - idleFrom) / 1_000);
    const status = await idle.streamingStatus();
    const ports = boundUdpPorts();
    console.log(
      `idle ${elapsed}s streaming-status=${status}` +
        ` reserved=${ports ? ports.has(endpoints.accessoryVideoPort) : 'not-observed'}`,
    );
    check(status === STREAMING_IN_USE, `the prepared session was still set up after ${elapsed}s`);
    if (ports) {
      check(ports.has(endpoints.accessoryVideoPort), `the reservation survived ${elapsed}s of an idle session`);
    }
  }
  observeAdaptation('after-idle', 0);

  const startedAt = Date.now();
  await idle.start(selection);
  const firstPacket = await waitFor(() => idle.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
  check(
    firstPacket !== undefined,
    `a start written after ${idleSeconds}s of idle preparation still streamed within` +
      ` ${FIRST_PACKET_TIMEOUT_MS / 1_000}s`,
  );
  if (firstPacket !== undefined) {
    console.log(`late start first video packet after ${Date.now() - startedAt}ms`);
    await delay(streamSeconds * 1_000);
    const report = idle.measured.report;
    console.log(
      `late start packets=${report.packets} frames=${report.frames} keyframes=${report.keyframes}` +
        ` unauthenticated=${report.unauthenticated}`,
    );
    check(report.unauthenticated === 0, 'the late start authenticated with the keys the idle preparation supplied');
  }
  await idle.end();
  await delay(RELEASE_GRACE_MS);
  observeReservation('after-end', endpoints.accessoryVideoPort, false);
  observeAdaptation('after-end', 0);

  console.log('abandoned prepared session, released by closing the controller connection');
  const abandoned = new LiveSession(client, accessory, address);
  sessions.push(abandoned);
  const abandonedEndpoints = await abandoned.setup();
  check(
    abandonedEndpoints.status === ENDPOINTS_ACCEPTED,
    'a further session negotiated after the earlier ones were released',
  );
  if (abandonedEndpoints.status === ENDPOINTS_ACCEPTED) {
    observeReservation('abandoned', abandonedEndpoints.accessoryVideoPort, true);
    await client.close();
    console.log('closed the controller HAP connection');
    await delay(RELEASE_GRACE_MS);
    check(
      (await abandoned.streamingStatus()) === STREAMING_AVAILABLE,
      'closing the controller connection returned the stream management service to available',
    );
    observeReservation('after-connection-close', abandonedEndpoints.accessoryVideoPort, false);
    observeAdaptation('after-connection-close', 0);
    let refused;
    try {
      await abandoned.start(selection);
      refused = false;
    } catch {
      refused = true;
    }
    check(refused === true, 'a start for the released session was refused rather than accepted against nothing');
    const renegotiated = new LiveSession(client, accessory, address);
    sessions.push(renegotiated);
    const renegotiatedEndpoints = await renegotiated.setup();
    check(
      renegotiatedEndpoints.status === ENDPOINTS_ACCEPTED,
      'the released stream management service negotiated a new session',
    );
    if (renegotiatedEndpoints.status === ENDPOINTS_ACCEPTED) {
      await renegotiated.end();
    }
  }
} finally {
  for (const session of sessions) {
    session.close();
  }
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  await client.close();
  console.log('removed the temporary controller pairing');
}

results.summarize();

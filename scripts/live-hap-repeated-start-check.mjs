/**
 * Repeated cold live-start comparison for two cameras.
 *
 * This diagnostic pairs one temporary controller with a dedicated, unpaired Homebridge instance and
 * alternates bounded starts between two explicitly selected cameras. Each attempt starts only after
 * the previous attempt has returned its HAP stream management service to available, released every FFmpeg
 * child, and reported release of the SDK consumer. It prints only accessory ids, product models,
 * negotiated video, timings, counts, and bounded lifecycle reasons. It retains no media and never prints
 * log lines.
 *
 * A guided diagnostics reproduction with the `live-media` profile must be active so the identity-free
 * `live-video-selected` event is present in the plugin JSONL. The JSONL is read only for that selection,
 * bounded condition reasons, and the plugin's live-session release event.
 *
 * Usage:
 *   node scripts/live-hap-repeated-start-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     --aids 6,14 --attempts 5 --seconds 10 --profile high --level 4.0 \
 *     --homebridge-pid 12345 --jsonl /tmp/hb-check/homebridge-eufy/logs/homebridge-eufy.jsonl \
 *     [--hap-controller /outside/repository/node_modules/hap-controller/lib/index.js] [--battery]
 *
 * A run wakes each selected camera. Battery cameras are refused unless `--battery` is passed. The script
 * removes its temporary pairing even when an attempt fails.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  ENDPOINTS_ACCEPTED,
  LiveSession,
  STREAMING_AVAILABLE,
  accessoryModel,
  adaptationProcesses,
  advertisedVideo,
  appendedJsonRecords,
  classifyLiveStartFailure,
  hasBattery,
  logMark,
  options,
  raisedConditions,
  refuseUnadvertised,
  required,
  selectCameras,
  videoSelection,
  waitFor,
} from './hap-live-harness.mjs';

const FIRST_PACKET_TIMEOUT_MS = 35_000;
const TEARDOWN_TIMEOUT_MS = 20_000;

const parsed = options(process.argv.slice(2));
const address = required(parsed, 'address');
const attempts = positiveInteger(parsed.get('attempts') ?? '5', 'attempts');
const seconds = positiveInteger(parsed.get('seconds') ?? '10', 'seconds');
const homebridgePid = required(parsed, 'homebridge-pid');
const pluginLogPath = required(parsed, 'jsonl');
const selection = videoSelection(parsed);
const aids = required(parsed, 'aids')
  .split(',')
  .map((value) => positiveInteger(value, 'aids'));
if (aids.length !== 2 || new Set(aids).size !== 2) {
  throw new Error('--aids must name exactly two distinct accessory ids');
}

const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`--${option} must be a positive integer`);
  }
  return number;
}

function diagnosticReason(mark) {
  return raisedConditions(mark).findLast(({ code }) =>
    ['camera-live-session-failed', 'camera-live-session-refused'].includes(code),
  )?.reason;
}

function hasPluginEvent(mark, event) {
  return appendedJsonRecords(mark).some((record) => record.event === event);
}

function hasSelectionTrace(mark, expected) {
  return appendedJsonRecords(mark).some(
    (record) =>
      record.event === 'live-video-selected' &&
      record.operation === 'start' &&
      record.profile === expected.profile &&
      record.levelName === expected.level &&
      record.width === expected.width &&
      record.height === expected.height &&
      record.fps === expected.fps,
  );
}

function liveFailure(mark) {
  return appendedJsonRecords(mark).findLast(
    (record) =>
      record.event === 'live-session-failed' && typeof record.stage === 'string' && typeof record.reason === 'string',
  );
}

function exactSelection(report, expected) {
  return (
    report.parameterSets.length > 0 &&
    report.parameterSets.every(
      (set) =>
        set.width === expected.width &&
        set.height === expected.height &&
        set.profile === expected.profile &&
        set.level === expected.level,
    )
  );
}

const client = new HttpClient(required(parsed, 'device-id'), address, Number(required(parsed, 'port')), undefined, {
  usePersistentConnections: true,
  subscriptionsUseSameConnection: true,
});
await client.pairSetup(required(parsed, 'pin'));
console.log('paired one temporary controller');

const totals = new Map(aids.map((aid) => [aid, { passed: 0, failed: 0 }]));
try {
  const { accessories } = await client.getAccessories();
  const cameras = aids.map((aid) => selectCameras(accessories, { aid })[0]);
  if (cameras.some((camera) => !camera)) {
    throw new Error('one or more --aids did not select a camera accessory');
  }
  if (!parsed.has('battery') && cameras.some(hasBattery)) {
    throw new Error('one or more selected cameras are battery powered; pass --battery to wake them deliberately');
  }
  for (const camera of cameras) {
    refuseUnadvertised(await advertisedVideo(client, camera), selection, `aid=${camera.aid} selection`);
    console.log(
      `camera aid=${camera.aid} model="${accessoryModel(camera)}" power=${hasBattery(camera) ? 'battery' : 'wired'}`,
    );
  }

  comparison: for (let round = 1; round <= attempts; round += 1) {
    for (const camera of cameras) {
      const label = `aid=${camera.aid} attempt=${round}`;
      const pluginMark = logMark(pluginLogPath);
      const session = new LiveSession(client, camera, address);
      let endpointStatus;
      let startAttempted = false;
      let startRejected = false;
      let started = false;
      let report;
      let firstPacketMs;
      let outputContinued;
      let cleanupReleased = false;
      let cleanupProcesses;
      let cleanupStatus;
      let sdkReleased = false;
      let traced = false;
      let reportedFailure;
      try {
        let endpoints;
        try {
          endpoints = await session.setup();
          endpointStatus = endpoints.status;
        } catch {}
        if (endpointStatus === ENDPOINTS_ACCEPTED) {
          startAttempted = true;
          try {
            await session.start(selection);
            started = true;
          } catch {
            startRejected = true;
          }
        }
        if (started) {
          firstPacketMs = await waitFor(() => {
            return session.measured.report.packets > 0;
          }, FIRST_PACKET_TIMEOUT_MS);
          if (firstPacketMs !== undefined) {
            const firstPackets = session.measured.report.packets;
            await delay(seconds * 1_000);
            outputContinued = session.measured.report.packets > firstPackets;
          }
          report = session.measured.report;
        }
      } finally {
        if (started) {
          try {
            await session.end();
          } catch {}
        }
        session.close();
        cleanupReleased =
          (await waitFor(async () => {
            const remaining = adaptationProcesses(homebridgePid) ?? [];
            const available = await session.streamingStatus().catch(() => undefined);
            cleanupProcesses = remaining.length;
            cleanupStatus = available;
            sdkReleased = hasPluginEvent(pluginMark, 'live-session-released');
            traced = !startAttempted || hasSelectionTrace(pluginMark, selection);
            reportedFailure = liveFailure(pluginMark);
            const failureTraceRequired = startRejected || (started && firstPacketMs === undefined);
            const sourceAcquired = started || (reportedFailure && reportedFailure.stage !== 'sdk-source-acquisition');
            return (
              remaining.length === 0 &&
              available === STREAMING_AVAILABLE &&
              traced &&
              (!failureTraceRequired || reportedFailure) &&
              (!sourceAcquired || sdkReleased)
            );
          }, TEARDOWN_TIMEOUT_MS)) !== undefined;
      }

      const reason = diagnosticReason(pluginMark);
      let failure = classifyLiveStartFailure({
        endpointStatus,
        startRejected,
        packets: report?.packets,
        outputContinued,
        reason: reportedFailure?.reason ?? reason,
        stage: reportedFailure?.stage,
        cleanupReleased,
      });
      if (!failure && report && !exactSelection(report, selection)) {
        failure = { stage: 'first-adapted-output', reason: 'negotiated-selection-mismatch' };
      }
      if (!failure && !traced) {
        failure = { stage: 'hap-preparation', reason: 'selection-trace-missing' };
      }

      if (failure) {
        totals.get(camera.aid).failed += 1;
        console.log(
          `${label} FAIL stage=${failure.stage} reason=${failure.reason}` +
            `${startAttempted ? ` selection=${selection.profile}/${selection.level}/${selection.width}x${selection.height}@${selection.fps}` : ''}` +
            ` trace=${traced} cleanup=${cleanupReleased} processes=${cleanupProcesses ?? 'unobserved'}` +
            ` stream-status=${cleanupStatus ?? 'unobserved'}`,
        );
      } else {
        totals.get(camera.aid).passed += 1;
        console.log(
          `${label} pass first-video-ms=${firstPacketMs} selection=${selection.profile}/${selection.level}/` +
            `${selection.width}x${selection.height}@${selection.fps} cleanup=true sdk-released=${sdkReleased}`,
        );
      }
      if (!cleanupReleased) {
        console.log('comparison stopped because the previous attempt did not prove complete release');
        break comparison;
      }
    }
  }
} finally {
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID).catch(() => undefined);
  client.close();
  console.log('removed the temporary controller pairing');
}

let failures = 0;
for (const [aid, total] of totals) {
  failures += total.failed;
  console.log(`SUMMARY aid=${aid} pass=${total.passed} fail=${total.failed}`);
}
if (failures > 0) {
  process.exitCode = 1;
}

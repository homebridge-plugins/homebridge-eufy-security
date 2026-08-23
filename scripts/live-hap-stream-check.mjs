/**
 * Live HomeKit stream qualification.
 *
 * Pairs a real HAP controller against a running Homebridge instance and drives complete negotiated live
 * sessions for a represented camera: `SetupEndpoints`, start, a mid-session snapshot, an optional
 * mid-session reconfiguration, an optional concurrent second session, then an explicit end. It exists
 * because negotiated live media cannot be qualified hermetically: it needs an authenticated account, a
 * reachable camera, P2P transport, and an ffmpeg binary.
 *
 * What it observes:
 *   - the accessory advertises the profile, level, and resolution this run requests, which is read from
 *     `SupportedVideoStreamConfiguration` and refused before any session is negotiated, because an
 *     accessory answers an unadvertised selection without complaint and would measure nothing;
 *   - the accessory accepts the negotiated selection and reports a streaming session;
 *   - every inbound packet authenticates with the SRTP key this controller supplied and carries the
 *     negotiated payload type and synchronisation source, with multiplexed RTCP counted separately;
 *   - the decrypted H.264 elementary stream carries exactly the negotiated coded dimensions, profile, and
 *     level in its sequence parameter sets, so the selection is proven on the wire and not only on a
 *     command line;
 *   - measured frame rate, keyframe cadence, and bit rate stay inside the negotiated maxima, and video
 *     continues across the RTCP interval while receiver reports are sent from the moment the session
 *     starts, because an accessory may terminate a session that receives no RTCP inside its startup
 *     grace, well before a slow camera has delivered a first frame;
 *   - a snapshot requested while the session is streaming is served as a structurally complete JPEG and
 *     leaves that session on its negotiated synchronisation source and SRTP key, with one adaptation
 *     process still running, because both acquisitions share one warm SDK source. As in
 *     `live-hap-snapshot-check.mjs`, the first request may legitimately be refused when the camera has no
 *     retained image yet and no stored acquisition, so a refused first round only settles and retries;
 *   - a mid-session reconfiguration changes the coded dimensions on the wire without ending the session
 *     or changing its synchronisation source;
 *   - a concurrent second session on the same camera streams alongside the first, and ending one leaves
 *     the other streaming;
 *   - audio absence or silence does not stop video, reported as a separate audio packet count;
 *   - sessions end on request and the accessory returns to an available streaming status;
 *   - with `--homebridge-pid`, adaptation processes exist while streaming, their arguments carry the
 *     negotiated dimensions, frame rate, and bit rate, and none survives the end of the sessions.
 *
 * Adaptation arguments are matched but never printed, because they carry SRTP key material. Decrypted
 * media is measured and discarded: no imagery is written to disk. Use `live-hap-capture.mjs` when a
 * maintainer needs to look at a frame. Receiver reports are plain RTCP rather than SRTCP; the plugin's
 * keepalive treats any datagram on the session port as liveness, which is the behavior under test.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-snapshot-check.mjs`: use a
 * dedicated Homebridge instance that is not paired to any controller, and provide `hap-controller`
 * through `--hap-controller <path>` or `HAP_CONTROLLER`.
 *
 * Usage:
 *   node scripts/live-hap-stream-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--aid 7] [--serial T8XXXXXXXXXXXXXX] [--battery] [--seconds 25] [--width 1280] [--height 720] \
 *     [--fps 30] [--bitrate 299] \
 *     [--profile main] [--level 3.1] [--no-reconfigure] [--no-snapshot] [--concurrent] \
 *     [--reconfigure-width 640] [--reconfigure-height 360] [--reconfigure-fps 15] \
 *     [--reconfigure-bitrate 150] [--snapshot-settle-ms 25000] [--homebridge-pid 12345] \
 *     [--instance-log /tmp/hb-check/instance.log] [--jsonl /tmp/hb-check/homebridge-eufy/logs/homebridge-eufy.jsonl]
 *
 * A live session wakes the camera and streams from it, so wired cameras are used unless `--battery` is
 * passed. A battery source bounds a continuous stream with a power budget the plugin must extend, so use
 * `--seconds 60` or more on a battery camera to cross that boundary. The script removes its own pairing
 * before exiting.
 *
 * `--profile` and `--level` select what this run negotiates and are judged exactly. Use
 * `live-hap-codec-matrix-check.mjs` to walk every advertised combination in one pairing.
 *
 * With `--instance-log` and `--jsonl` it also judges the log sections the run appended: a Homebridge
 * service log free of failure and cleanup lines, and a plugin JSONL free of error records. Only levels,
 * counts, and kebab-case condition codes are printed, never a log line, because those files carry
 * support-sensitive context even though plugin output is allowlisted. Both files must be readable by the
 * account running this script, so run it as the account that owns the Homebridge storage.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  ENDPOINTS_ACCEPTED,
  LiveSession,
  STREAMING_AVAILABLE,
  STREAMING_IN_USE,
  accessoryModel,
  adaptationProcesses,
  advertisedVideo,
  appendedLines,
  cameraStreamManagements,
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
const RECONFIGURE_TIMEOUT_MS = 20_000;
const TEARDOWN_GRACE_MS = 5_000;
const LATE_WINDOW_SECONDS = 10;
const RECONFIGURED_WINDOW_SECONDS = 5;
const SNAPSHOT_WINDOW_SECONDS = 5;
const CONCURRENT_WINDOW_SECONDS = 10;

const parsed = options(process.argv.slice(2));
const address = required(parsed, 'address');
const seconds = Number(parsed.get('seconds') ?? 25);
const selection = videoSelection(parsed);
const reconfigured = {
  ...selection,
  width: Number(parsed.get('reconfigure-width') ?? 640),
  height: Number(parsed.get('reconfigure-height') ?? 360),
  fps: Number(parsed.get('reconfigure-fps') ?? 15),
  bitrate: Number(parsed.get('reconfigure-bitrate') ?? 150),
};
const snapshotSettleMs = Number(parsed.get('snapshot-settle-ms') ?? 25_000);
const homebridgePid = parsed.get('homebridge-pid');
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const results = observations('live stream qualification');
const check = results.check;

const FAILURE_LINE = /\b(error|failed|failure|exception|unhandled|cleanup)\b/i;

/** Judges the Homebridge service log section this run produced by level and condition code only. */
function judgeInstanceLog(mark) {
  if (!mark) {
    results.unverified('instance-log=not-observed (pass --instance-log to verify it)');
    return;
  }
  const lines = appendedLines(mark);
  const failing = lines.filter((line) => FAILURE_LINE.test(line));
  const codes = conditionCodes(lines);
  console.log(
    `instance-log lines=${lines.length} conditions=[${[...codes].join(',')}] failure-lines=${failing.length}`,
  );
  check(failing.length === 0, 'the Homebridge log recorded no failure or repeated cleanup line for the session');
}

/** Judges the plugin JSONL section this run produced by level and condition code only. */
function judgePluginLog(mark) {
  if (!mark) {
    results.unverified('plugin-jsonl=not-observed (pass --jsonl to verify it)');
    return;
  }
  const records = appendedLines(mark).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const levels = {};
  const codes = new Set();
  for (const record of records) {
    levels[record.level] = (levels[record.level] ?? 0) + 1;
    if (record.code && record.level !== 'debug') {
      codes.add(record.code);
    }
  }
  console.log(
    `plugin-jsonl records=${records.length} levels=${JSON.stringify(levels)} conditions=[${[...codes].join(',')}]`,
  );
  check((levels.error ?? 0) === 0, 'the plugin JSONL recorded no error condition for the session');
}

/**
 * Adaptation processes the plugin owns, with the negotiated selection matched but never printed.
 *
 * Video and audio are separate inputs and therefore separate processes, so they are counted separately:
 * one video adaptation per expected session, and one audio adaptation per session only when the camera
 * actually delivered source audio. Counting them together fails every audio-capable camera. A video
 * adaptation is the one asked to drop audio, and an audio adaptation the one asked to drop video, which is
 * the only part of an argument list that may be matched here because the rest carries SRTP key material.
 */
function observeAdaptation(label, expectedSessions, applied) {
  const processes = adaptationProcesses(homebridgePid);
  if (processes === undefined) {
    results.unverified(`${label} adaptation processes=not-observed (pass --homebridge-pid to verify them)`);
    return;
  }
  const video = processes.filter(({ args }) => / -an\b/.test(args));
  const audio = processes.filter(({ args }) => / -vn\b/.test(args));
  console.log(`${label} adaptation processes=${processes.length} video=${video.length} audio=${audio.length}`);
  check(video.length === expectedSessions, `${label} ran exactly ${expectedSessions} video adaptation(s)`);
  check(
    audio.length <= expectedSessions,
    `${label} ran no more than ${expectedSessions} audio adaptation(s), one per session that carried source audio`,
  );
  check(
    video.length + audio.length === processes.length,
    `${label} ran no adaptation process that was neither the video nor the audio of a session`,
  );
  if (!applied || video.length === 0) {
    return;
  }
  check(
    video.some(({ args }) => args.includes(`${applied.width}:${applied.height}`)),
    `${label} adaptation applied ${applied.width}x${applied.height}`,
  );
  check(
    video.some(({ args }) => new RegExp(`-r\\s+${applied.fps}\\b`).test(args)),
    `${label} adaptation applied ${applied.fps}fps`,
  );
  check(
    video.some(({ args }) => args.includes(`${applied.bitrate}k`)),
    `${label} adaptation applied ${applied.bitrate}kbps`,
  );
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
  const cameras = selectCameras(accessories, {
    battery: parsed.has('battery'),
    ...(parsed.has('aid') ? { aid: parsed.get('aid') } : {}),
    ...(parsed.has('serial') ? { serial: parsed.get('serial') } : {}),
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
  if (!parsed.has('no-reconfigure')) {
    refuseUnadvertised(advertised, reconfigured, 'reconfigured selection');
  }

  const primary = new LiveSession(client, accessory, address);
  sessions.push(primary);
  const endpoints = await primary.setup();
  if (endpoints.status !== ENDPOINTS_ACCEPTED) {
    throw new Error(`accessory refused endpoint setup with status ${endpoints.status}`);
  }
  console.log(
    `endpoints accepted accessory-video-port=${endpoints.accessoryVideoPort} video-ssrc=${endpoints.videoSsrc}`,
  );

  const startedAt = Date.now();
  await primary.start(selection);
  console.log(
    `start-session accepted ${selection.width}x${selection.height}@${selection.fps} ${selection.bitrate}kbps`,
  );
  const firstPacket = await waitFor(() => primary.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
  check(firstPacket !== undefined, `video started within ${FIRST_PACKET_TIMEOUT_MS / 1_000}s of start-session`);
  if (firstPacket !== undefined) {
    console.log(`first video packet after ${Date.now() - startedAt}ms`);
  }

  const early = primary.measured.report;
  const observedFrom = Date.now();
  await delay(Math.max(seconds - LATE_WINDOW_SECONDS, 0) * 1_000);
  const late = primary.measured.report;
  await delay(Math.min(seconds, LATE_WINDOW_SECONDS) * 1_000);
  const streaming = primary.measured.report;
  observeAdaptation('primary', 1, selection);
  judgeWindow(results, {
    label: 'primary',
    window: measuredWindow(streaming, early),
    seconds: (Date.now() - observedFrom) / 1_000,
    expected: selection,
    session: streaming,
  });
  check(streaming.packets > early.packets, 'primary continued past its first packets across the RTCP interval');
  check(
    streaming.frames > late.frames,
    `primary was still delivering frames in its last ${LATE_WINDOW_SECONDS}s, so no source budget or` +
      ' linger boundary stopped it mid-session',
  );
  check(streaming.rtcpPackets > 0, 'primary received accessory RTCP inside the session');
  console.log(`primary audio-packets=${primary.audioPackets}`);
  check(
    streaming.frames > early.frames,
    'primary kept delivering complete video frames while source audio was silent or absent',
  );

  if (!parsed.has('no-snapshot') && streaming.packets > 0) {
    const beforeSnapshot = primary.measured.report;
    let served;
    for (const round of [1, 2]) {
      const requestedAt = Date.now();
      try {
        served = await snapshotImage(client, accessory.aid);
        console.log(
          `mid-session snapshot round=${round} after ${Date.now() - requestedAt}ms` +
            ` bytes=${served.bytes} digest=${served.digest}`,
        );
        break;
      } catch (error) {
        console.log(
          `mid-session snapshot round=${round} refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (round === 1) {
        await delay(snapshotSettleMs);
      }
    }
    check(
      served !== undefined,
      'the accessory served a snapshot while its live session was streaming, once its acquisition had settled',
    );
    if (served) {
      check(served.structural, 'the mid-session snapshot was a structurally complete JPEG');
    }
    await delay(SNAPSHOT_WINDOW_SECONDS * 1_000);
    const afterSnapshot = primary.measured.report;
    check(afterSnapshot.packets > beforeSnapshot.packets, 'the live session kept streaming across the snapshot');
    check(afterSnapshot.ssrcs.size === 1, 'the snapshot left the session on its negotiated synchronisation source');
    check(
      afterSnapshot.unauthenticated === beforeSnapshot.unauthenticated,
      'the snapshot left the session on its negotiated SRTP key',
    );
    check(
      (await primary.streamingStatus()) === STREAMING_IN_USE,
      'the accessory still reported an in-use streaming session after the snapshot',
    );
    observeAdaptation('after-snapshot', 1, selection);
  }

  if (!parsed.has('no-reconfigure') && streaming.packets > 0) {
    console.log(
      `reconfigure to ${reconfigured.width}x${reconfigured.height}@${reconfigured.fps} ${reconfigured.bitrate}kbps`,
    );
    const before = primary.measured.report;
    await primary.reconfigure(reconfigured);
    const changed = await waitFor(() => {
      const coded = primary.measured.report.parameterSets.at(-1);
      return coded?.width === reconfigured.width && coded?.height === reconfigured.height;
    }, RECONFIGURE_TIMEOUT_MS);
    check(changed !== undefined, `reconfigured dimensions reached the wire within ${RECONFIGURE_TIMEOUT_MS / 1_000}s`);
    const reconfiguredAt = primary.measured.report;
    const reconfiguredFrom = Date.now();
    await delay(RECONFIGURED_WINDOW_SECONDS * 1_000);
    const after = primary.measured.report;
    check(after.packets > before.packets, 'the session continued through the reconfiguration');
    check(after.ssrcs.size === 1, 'the reconfigured session kept its negotiated synchronisation source');
    check(after.unauthenticated === before.unauthenticated, 'the reconfigured session kept the negotiated SRTP key');
    check(
      (await primary.streamingStatus()) === STREAMING_IN_USE,
      'the accessory still reported an in-use streaming session',
    );
    observeAdaptation('reconfigured', 1, reconfigured);
    judgeWindow(results, {
      label: 'reconfigured',
      window: measuredWindow(after, reconfiguredAt),
      seconds: (Date.now() - reconfiguredFrom) / 1_000,
      expected: reconfigured,
    });
  }

  if (parsed.has('concurrent')) {
    check(streamCount > 1, 'the accessory advertises more than one stream management service');
    const secondary = new LiveSession(client, accessory, address, { streamIndex: 1 });
    sessions.push(secondary);
    const secondaryEndpoints = await secondary.setup();
    check(
      secondaryEndpoints.status === ENDPOINTS_ACCEPTED,
      'a concurrent second session was accepted for endpoint setup',
    );
    if (secondaryEndpoints.status === ENDPOINTS_ACCEPTED) {
      const concurrentFrom = primary.measured.report;
      await secondary.start(selection);
      const secondaryFirst = await waitFor(() => secondary.measured.report.packets > 0, FIRST_PACKET_TIMEOUT_MS);
      check(secondaryFirst !== undefined, 'the concurrent session delivered video of its own');
      const secondaryEarly = secondary.measured.report;
      const observedConcurrentFrom = Date.now();
      await delay(CONCURRENT_WINDOW_SECONDS * 1_000);
      judgeWindow(results, {
        label: 'concurrent',
        window: measuredWindow(secondary.measured.report, secondaryEarly),
        seconds: (Date.now() - observedConcurrentFrom) / 1_000,
        expected: selection,
        session: secondary.measured.report,
      });
      check(
        primary.measured.report.packets > concurrentFrom.packets,
        'the first session kept streaming while the concurrent session ran',
      );
      observeAdaptation('concurrent', 2);
      const beforeEnd = primary.measured.report;
      await secondary.end();
      await delay(TEARDOWN_GRACE_MS);
      check(
        primary.measured.report.packets > beforeEnd.packets,
        'the first session survived the end of the concurrent session',
      );
      observeAdaptation('after-concurrent-end', 1);
      check(
        (await secondary.streamingStatus()) === STREAMING_AVAILABLE,
        'the concurrent stream management returned to available',
      );
    }
  }

  await primary.end();
  await delay(TEARDOWN_GRACE_MS);
  observeAdaptation('after-end', 0);
  check(
    (await primary.streamingStatus()) === STREAMING_AVAILABLE,
    'the accessory returned to an available streaming status',
  );
  judgeInstanceLog(instanceLog);
  judgePluginLog(pluginLog);
} finally {
  for (const session of sessions) {
    session.close();
  }
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

results.summarize();

/**
 * Live HomeKit media capture for visual inspection.
 *
 * Negotiates one HomeKit live session per camera against a running Homebridge instance, decrypts the
 * inbound SRTP with the keys this controller supplied, depacketizes H.264, and writes one MP4 plus one
 * still frame per camera so a maintainer can actually look at what HomeKit receives. It complements
 * `live-hap-stream-check.mjs`, which measures the same decrypted stream but keeps no media.
 *
 * This tool writes real camera imagery to disk. It refuses to write inside a git working tree, and the
 * output belongs outside any repository, backup, issue, or support archive. Delete it when the visual
 * check is done. Files are named by product model and accessory id, never by the owner's chosen name.
 *
 * Prerequisites and controller module resolution match `live-hap-snapshot-check.mjs`: a dedicated
 * Homebridge instance that is not paired to any controller, and `hap-controller` provided through
 * `--hap-controller <path>` or `HAP_CONTROLLER`.
 *
 * Usage:
 *   node scripts/live-hap-capture.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     --output /tmp/eufy-capture [--battery] [--aid 7] [--seconds 20] [--warmup 30]
 *
 * A session wakes the camera and streams from it, so battery cameras are skipped unless `--battery` is
 * passed. Audio is not captured: HomeKit return audio and camera audio are separate contracts, and a
 * silent video-only session is the common case this tool inspects.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LiveSession,
  accessoryModel,
  hasBattery,
  options,
  required,
  selectCameras,
  waitFor,
} from './hap-live-harness.mjs';

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** One negotiated session, decrypted and muxed into a playable file. */
async function capture(client, accessory, settings) {
  const target = join(
    settings.output,
    `${accessoryModel(accessory).replaceAll(/[^A-Za-z0-9]+/g, '-')}-aid${accessory.aid}.mp4`,
  );
  const muxer = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'h264',
      '-r',
      String(settings.fps),
      '-i',
      'pipe:0',
      '-c:v',
      'copy',
      '-movflags',
      '+faststart',
      target,
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  );
  muxer.stdin.on('error', () => undefined);

  let started = false;
  const session = new LiveSession(client, accessory, settings.address, {
    onNalUnit: (nal) => {
      started ||= (nal[0] & 0x1f) === 7;
      if (started) {
        muxer.stdin.write(Buffer.concat([START_CODE, nal]));
      }
    },
  });
  const endpoints = await session.setup();
  if (endpoints.status !== 0) {
    session.close();
    muxer.stdin.end();
    return { status: `endpoint setup refused with status ${endpoints.status}` };
  }

  await session.start({
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    bitrate: settings.bitrate,
    videoPayloadType: 99,
    audioPayloadType: 110,
  });
  if ((await waitFor(() => session.measured.report.packets > 0, settings.warmup * 1_000)) !== undefined) {
    await delay(settings.seconds * 1_000);
  }
  const report = session.measured.report;
  await session.end();
  session.close();
  muxer.stdin.end();
  await new Promise((finished) => muxer.on('exit', finished));

  const observed = {
    packets: report.packets,
    keyframes: report.keyframes,
    frames: report.frames,
    coded: report.parameterSets.map((set) => `${set.width}x${set.height} ${set.profile}@${set.level}`).join(' -> '),
  };
  if (report.frames === 0) {
    return { status: 'no decodable video arrived', ...observed };
  }
  const still = target.replace(/\.mp4$/, '.jpg');
  spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', target, '-frames:v', '1', '-q:v', '2', still], {
    stdio: 'inherit',
  });
  return { status: 'captured', file: target, still, ...observed };
}

const parsed = options(process.argv.slice(2));
const output = resolve(required(parsed, 'output'));
if (existsSync(join(output, '.git')) || existsSync(join(resolve(output, '..'), '.git'))) {
  throw new Error(`${output} is inside a git working tree; camera imagery must not be written there`);
}
mkdirSync(output, { recursive: true });
const settings = {
  address: required(parsed, 'address'),
  output,
  seconds: Number(parsed.get('seconds') ?? 20),
  warmup: Number(parsed.get('warmup') ?? 30),
  width: Number(parsed.get('width') ?? 1280),
  height: Number(parsed.get('height') ?? 720),
  fps: Number(parsed.get('fps') ?? 30),
  bitrate: Number(parsed.get('bitrate') ?? 299),
};
const controllerModule = parsed.get('hap-controller') ?? process.env.HAP_CONTROLLER ?? 'hap-controller';
const { HttpClient } = await import(controllerModule).catch(() => {
  throw new Error(`hap-controller is unavailable at ${controllerModule}; install it outside this repository`);
});

const client = new HttpClient(
  required(parsed, 'device-id'),
  settings.address,
  Number(required(parsed, 'port')),
  undefined,
  { usePersistentConnections: true, subscriptionsUseSameConnection: true },
);
await client.pairSetup(required(parsed, 'pin'));
console.log(`paired one temporary controller; writing to ${output}`);

try {
  const { accessories } = await client.getAccessories();
  const selected = selectCameras(accessories, {
    battery: parsed.has('battery'),
    ...(parsed.has('aid') ? { aid: parsed.get('aid') } : {}),
  });
  console.log(`selected=${selected.length}`);

  for (const accessory of selected) {
    console.log(
      `aid=${accessory.aid} model="${accessoryModel(accessory)}" power=${hasBattery(accessory) ? 'battery' : 'wired'}`,
    );
    const result = await capture(client, accessory, settings);
    console.log(
      `  ${result.status}${result.packets === undefined ? '' : ` packets=${result.packets} frames=${result.frames} keyframes=${result.keyframes} coded=${result.coded}`}`,
    );
  }
} finally {
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

/**
 * Qualifies the plugin's controller-to-camera return-audio path against a real camera.
 *
 * This is a REAL DEVICE WRITE: it opens the camera speaker and plays a short synthetic tone. Run it only
 * with explicit approval, against a COPY of the plugin storage root, and with the Homebridge instance that
 * owns the account stopped. It prints only the last four characters of the camera serial and writes no
 * media to disk.
 *
 * The controller side is a local FFmpeg process producing the 16 kHz mono AAC-ELD SRTP HomeKit negotiates.
 * The accessory side is the plugin's own FfmpegLiveMedia: SRTP receive, AAC-ELD decode, AAC-LC ADTS output,
 * one SDK talkback handle, budget/lifetime policy, and independent outbound adaptation.
 *
 * Usage:
 *   npm run build
 *   node scripts/live-talkback-check.mjs \
 *     --storage /tmp/hb-check/homebridge-eufy --serial T8XXXXXXXXXXXXXX [--battery] \
 *     [--seconds 2] [--frequency 880]
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import { observations, options, required } from './hap-live-harness.mjs';
import { openCameraSession, shortSerial } from './eufy-camera-session.mjs';

function exited(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`return-audio sender exited code=${code} signal=${signal}: ${stderr.slice(-400)}`));
    });
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

const parsed = options(process.argv.slice(2));
const serial = required(parsed, 'serial');
const storage = required(parsed, 'storage');
const seconds = Number(parsed.get('seconds') ?? 2);
const frequency = Number(parsed.get('frequency') ?? 880);
const sourceHints = parsed.get('battery') === undefined ? { preBufferSeconds: 4 } : {};
const require = createRequire(import.meta.url);
const ffmpeg = parsed.get('ffmpeg') ?? require('ffmpeg-for-homebridge');
const { FfmpegLiveMedia } = await import('../dist/media/live-stream.js').catch(() => {
  throw new Error('dist/ is missing; run npm run build before this check');
});
const results = observations('talkback qualification');
const session = await openCameraSession(storage);

try {
  const { actions } = await session.camera(serial);
  console.log(`camera ${shortSerial(serial)} talkback=${typeof actions.talkback}`);
  results.check(typeof actions.talkback === 'function', 'the camera exposes an evidenced SDK talkback action');
  if (typeof actions.talkback !== 'function') {
    throw new Error(`${shortSerial(serial)} exposes no talkback action`);
  }

  const audioKey = randomBytes(16);
  const audioSalt = randomBytes(14);
  const outcomes = [];
  let opened = 0;
  let stopped = 0;
  let outboundFrames = 0;
  const source = {
    live: async () => {
      const handle = await actions.live(sourceHints);
      handle.on('video', () => (outboundFrames += 1));
      return handle;
    },
    talkback: async () => {
      opened += 1;
      const handle = await actions.talkback(sourceHints);
      handle.on('stop', () => (stopped += 1));
      return handle;
    },
  };
  const prepared = await new FfmpegLiveMedia(ffmpeg).prepare({
    addressVersion: 'ipv4',
    targetAddress: '127.0.0.1',
    video: {
      port: 50100,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: randomBytes(16),
      srtpSalt: randomBytes(14),
    },
    audio: {
      port: 50101,
      srtpCryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
      srtpKey: audioKey,
      srtpSalt: audioSalt,
    },
    onSessionOutcome: (outcome) => outcomes.push({ scope: 'outbound', ...outcome }),
    onTalkbackOutcome: (outcome) => outcomes.push({ scope: 'talkback', ...outcome }),
  });

  try {
    await prepared.start(source, {
      video: {
        width: 1280,
        height: 720,
        fps: 15,
        maxBitRate: 800,
        profile: 'main',
        level: '3.1',
        payloadType: 99,
        ssrc: 1234,
        mtu: 1200,
        rtcpInterval: 0.5,
      },
      audio: {
        codec: 'AAC-eld',
        channels: 1,
        sampleRate: 16,
        maxBitRate: 24,
        payloadType: 110,
        ssrc: 5678,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const outboundReady = await waitFor(() => outboundFrames > 0, 30_000);
    results.check(outboundReady, 'outbound video was streaming before return audio started');
    const framesBeforeTalkback = outboundFrames;

    if (outboundReady) {
      const key = Buffer.concat([audioKey, audioSalt]).toString('base64');
      const sender = spawn(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'warning',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=${frequency}:sample_rate=16000:duration=${seconds}`,
          '-vn',
          '-c:a',
          'libfdk_aac',
          '-profile:a',
          'aac_eld',
          '-flags',
          '+global_header',
          '-ar',
          '16k',
          '-ac',
          '1',
          '-b:a',
          '24k',
          '-payload_type',
          '110',
          '-ssrc',
          '5678',
          '-f',
          'rtp',
          '-srtp_out_suite',
          'AES_CM_128_HMAC_SHA1_80',
          '-srtp_out_params',
          key,
          `srtp://127.0.0.1:${prepared.audioPort}?rtcpport=${prepared.audioPort}&pkt_size=188`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      await exited(sender);
      await new Promise((resolve) => setTimeout(resolve, 750));
      results.check(outboundFrames > framesBeforeTalkback, 'outbound video continued while return audio played');
    }
  } finally {
    prepared.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 250));

  console.log(`outcomes=${JSON.stringify(outcomes)} handles opened=${opened} stopped=${stopped}`);
  results.check(opened === 1, 'HomeKit return audio opened exactly one SDK talkback handle');
  results.check(stopped === 1, 'ending the HomeKit session stopped that SDK talkback handle');
  results.check(
    outcomes.some(({ scope, outcome }) => scope === 'talkback' && outcome === 'talking'),
    'decoded return audio reached the SDK talkback path',
  );
  results.check(
    !outcomes.some(({ scope, outcome }) => scope === 'talkback' && outcome === 'failed'),
    'the talkback lifecycle reported no isolated failure',
  );
  results.check(
    !outcomes.some(({ scope, outcome }) => scope === 'outbound' && outcome === 'failed'),
    'outbound media reported no failure',
  );
} finally {
  await session.close();
}

results.summarize();

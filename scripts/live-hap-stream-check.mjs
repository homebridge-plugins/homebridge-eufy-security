/**
 * Live HomeKit stream qualification.
 *
 * Pairs a real HAP controller against a running Homebridge instance and drives one complete negotiated
 * live session for a represented camera: `SetupEndpoints`, `SelectedRTPStreamConfiguration` start,
 * inbound SRTP observation with periodic RTCP receiver reports, then an explicit end-session. It exists
 * because negotiated live media cannot be qualified hermetically: it needs an authenticated account, a
 * reachable camera, P2P transport, and an ffmpeg binary.
 *
 * What it observes, without decrypting media:
 *   - the accessory accepts the negotiated selection and reports a streaming session;
 *   - inbound RTP carries the negotiated payload type and synchronisation source, with multiplexed
 *     RTCP sender reports counted separately;
 *   - video continues across the RTCP interval while receiver reports are sent;
 *   - measured packet rate, byte rate, and RTP timestamp cadence stay inside the negotiated frame rate
 *     and bitrate;
 *   - audio absence or silence does not stop video, reported as a separate audio packet count;
 *   - the session ends on request and the accessory returns to an available streaming status;
 *   - with `--homebridge-pid`, one adaptation process exists while streaming, its arguments carry the
 *     negotiated dimensions, frame rate, and bitrate, and none survives the end of the session.
 *
 * Adaptation arguments are matched but never printed, because they carry SRTP key material.
 *
 * SRTP payloads are never decrypted, so image content is not inspected and no media is written to disk.
 * Receiver reports are plain RTCP rather than SRTCP; the plugin's keepalive treats any datagram on the
 * session port as liveness, which is the behavior under test.
 *
 * Prerequisites and controller module resolution are identical to `live-hap-snapshot-check.mjs`: use a
 * dedicated Homebridge instance that is not paired to any controller, and provide `hap-controller`
 * through `--hap-controller <path>` or `HAP_CONTROLLER`.
 *
 * The controller must hold one persistent HAP connection, because an accessory ties the streaming
 * session to the connection that wrote `SetupEndpoints` and tears the session down when it closes.
 *
 * Usage:
 *   node scripts/live-hap-stream-check.mjs \
 *     --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
 *     [--aid 7] [--battery] [--seconds 25] [--width 1280] [--height 720] [--fps 30] [--bitrate 299] \
 *     [--homebridge-pid 12345]
 *
 * A live session wakes the camera and streams from it, so wired cameras are used unless `--battery`
 * is passed. The script removes its own pairing before exiting.
 */
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const CAMERA_RTP_STREAM_MANAGEMENT = '00000110-0000-1000-8000-0026BB765291';
const BATTERY = '00000096-0000-1000-8000-0026BB765291';
const SETUP_ENDPOINTS = '00000118';
const SELECTED_RTP_STREAM_CONFIGURATION = '00000117';
const STREAMING_STATUS = '00000120';
const AES_CM_128_HMAC_SHA1_80 = 0;
const H264 = 0;
const AAC_ELD = 2;
const START_SESSION = 1;
const END_SESSION = 0;

function options(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) {
      continue;
    }
    const next = argv[index + 1];
    parsed.set(argv[index].slice(2), next && !next.startsWith('--') ? next : 'true');
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

function tlv(...pairs) {
  const chunks = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const type = pairs[index];
    const payload = Buffer.isBuffer(pairs[index + 1]) ? pairs[index + 1] : Buffer.from([pairs[index + 1]]);
    for (let offset = 0; offset < Math.max(payload.length, 1); offset += 255) {
      const fragment = payload.subarray(offset, offset + 255);
      chunks.push(Buffer.from([type, fragment.length]), fragment);
    }
  }
  return Buffer.concat(chunks);
}

function untlv(buffer) {
  const values = new Map();
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const type = buffer[offset];
    const length = buffer[offset + 1];
    const fragment = buffer.subarray(offset + 2, offset + 2 + length);
    values.set(type, values.has(type) ? Buffer.concat([values.get(type), fragment]) : fragment);
    offset += 2 + length;
  }
  return values;
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

async function reservePort() {
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', resolve);
  });
  return {
    port: socket.address().port,
    socket,
  };
}

/** RFC 5761 multiplexes RTCP on the RTP port; packet types 200-204 are RTCP, not media. */
function isRtcp(packet) {
  const packetType = packet[1] & 0xff;
  return packetType >= 200 && packetType <= 204;
}

/**
 * Adaptation processes the accessory owns for this session, observed only when a pid is supplied.
 * Arguments are returned for matching against the negotiated selection and must not be printed,
 * because they carry SRTP key material.
 */
function adaptationProcesses(pid) {
  if (!pid) {
    return undefined;
  }
  const listing = execFileSync('ps', ['-ax', '-o', 'ppid=,args='], { encoding: 'utf8' });
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf(' ');
      return { parent: Number(line.slice(0, separator)), args: line.slice(separator + 1) };
    })
    .filter(({ parent, args }) => parent === Number(pid) && args.includes('ffmpeg'));
}

/** A minimal RTCP receiver report, enough for the accessory's session keepalive. */
function receiverReport(senderSsrc, sourceSsrc, highestSequence, packets) {
  const report = Buffer.alloc(32);
  report.writeUInt8(0x81, 0);
  report.writeUInt8(201, 1);
  report.writeUInt16BE(7, 2);
  report.writeUInt32BE(senderSsrc, 4);
  report.writeUInt32BE(sourceSsrc, 8);
  report.writeUInt8(0, 12);
  report.writeUIntBE(0, 13, 3);
  report.writeUInt32BE(highestSequence, 16);
  report.writeUInt32BE(0, 20);
  report.writeUInt32BE(0, 24);
  report.writeUInt32BE(packets, 28);
  return report;
}

const parsed = options(process.argv.slice(2));
const seconds = Number(parsed.get('seconds') ?? 25);
const width = Number(parsed.get('width') ?? 1280);
const height = Number(parsed.get('height') ?? 720);
const fps = Number(parsed.get('fps') ?? 30);
const maxBitrate = Number(parsed.get('bitrate') ?? 299);
const videoPayloadType = 99;
const audioPayloadType = 110;
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
const video = await reservePort();
const audio = await reservePort();
try {
  const { accessories } = await client.getAccessories();
  const cameras = accessories.filter((accessory) =>
    accessory.services.some((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT),
  );
  const selectable = parsed.has('battery')
    ? cameras
    : cameras.filter((accessory) => !accessory.services.some((service) => service.type.toUpperCase() === BATTERY));
  const accessory = parsed.has('aid')
    ? cameras.find(({ aid }) => aid === Number(parsed.get('aid')))
    : selectable[0];
  if (!accessory) {
    throw new Error('no camera accessory matched the selection');
  }
  const management = accessory.services.find(
    (service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT,
  );
  const characteristic = (prefix) => {
    const found = management.characteristics.find((entry) => entry.type.toUpperCase().startsWith(prefix));
    if (!found) {
      throw new Error(`camera service is missing characteristic ${prefix}`);
    }
    return `${accessory.aid}.${found.iid}`;
  };
  console.log(`camera aid=${accessory.aid} wired=${selectable.includes(accessory)} ports video=${video.port} audio=${audio.port}`);

  const sessionId = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  const videoKey = randomBytes(16);
  const videoSalt = randomBytes(14);
  const audioKey = randomBytes(16);
  const audioSalt = randomBytes(14);
  const setup = tlv(
    1,
    sessionId,
    3,
    tlv(1, 0, 2, Buffer.from(required(parsed, 'address'), 'utf8'), 3, uint16(video.port), 4, uint16(audio.port)),
    4,
    tlv(1, AES_CM_128_HMAC_SHA1_80, 2, videoKey, 3, videoSalt),
    5,
    tlv(1, AES_CM_128_HMAC_SHA1_80, 2, audioKey, 3, audioSalt),
  );
  await client.setCharacteristics({ [characteristic(SETUP_ENDPOINTS)]: setup.toString('base64') });
  const response = await client.getCharacteristics([characteristic(SETUP_ENDPOINTS)]);
  const negotiated = untlv(Buffer.from(response.characteristics[0].value, 'base64'));
  const status = negotiated.get(2)?.[0];
  if (status !== 0) {
    throw new Error(`accessory refused endpoint setup with status ${status}`);
  }
  const accessoryAddress = untlv(negotiated.get(3));
  const accessoryVideoPort = accessoryAddress.get(3).readUInt16LE(0);
  const videoSsrc = negotiated.get(6).readUInt32LE(0);
  const audioSsrc = negotiated.get(7).readUInt32LE(0);
  console.log(`endpoints accepted accessory-video-port=${accessoryVideoPort} video-ssrc=${videoSsrc >>> 0}`);

  const observed = {
    videoPackets: 0,
    videoBytes: 0,
    audioPackets: 0,
    accessoryReports: 0,
    payloadTypes: new Set(),
    ssrcs: new Set(),
  };
  const timestamps = new Set();
  let highestSequence = 0;
  video.socket.on('message', (packet) => {
    if (packet.length < 12) {
      return;
    }
    if (isRtcp(packet)) {
      observed.accessoryReports += 1;
      return;
    }
    observed.videoPackets += 1;
    observed.videoBytes += packet.length;
    observed.payloadTypes.add(packet[1] & 0x7f);
    observed.ssrcs.add(packet.readUInt32BE(8));
    highestSequence = Math.max(highestSequence, packet.readUInt16BE(2));
    timestamps.add(packet.readUInt32BE(4));
  });
  audio.socket.on('message', (packet) => {
    if (!isRtcp(packet)) {
      observed.audioPackets += 1;
    }
  });

  const selection = tlv(
    1,
    tlv(1, sessionId, 2, START_SESSION),
    2,
    tlv(
      1,
      H264,
      2,
      tlv(1, 1, 2, 0, 3, 1),
      3,
      tlv(1, uint16(width), 2, uint16(height), 3, fps),
      4,
      tlv(1, videoPayloadType, 2, uint32(videoSsrc), 3, uint16(maxBitrate), 4, Buffer.from([0, 0, 0x80, 0x3f])),
    ),
    3,
    tlv(
      1,
      AAC_ELD,
      2,
      tlv(1, 1, 2, 0, 3, 0, 4, 30),
      3,
      tlv(1, audioPayloadType, 2, uint32(audioSsrc), 3, uint16(24), 4, Buffer.from([0, 0, 0x80, 0x3f]), 6, 13),
      4,
      0,
    ),
  );
  const startedAt = Date.now();
  await client.setCharacteristics({ [characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: selection.toString('base64') });
  console.log('start-session accepted');

  const reports = setInterval(() => {
    if (observed.videoPackets === 0) {
      return;
    }
    video.socket.send(
      receiverReport(0x4f4f4f4f, videoSsrc >>> 0, highestSequence, observed.videoPackets),
      accessoryVideoPort,
      required(parsed, 'address'),
    );
  }, 1_000);
  const firstPacketAt = await (async () => {
    for (let waited = 0; waited < 20_000; waited += 250) {
      if (observed.videoPackets > 0) {
        return Date.now();
      }
      await delay(250);
    }
    return undefined;
  })();
  if (!firstPacketAt) {
    failures += 1;
    console.log('no inbound video within 20s of start-session');
  } else {
    console.log(`first video packet after ${firstPacketAt - startedAt}ms`);
  }
  const midpoint = { ...observed, timestamps: timestamps.size };
  await delay(seconds * 1_000);
  const streamingProcesses = adaptationProcesses(parsed.get('homebridge-pid'));
  clearInterval(reports);

  const elapsedSeconds = (Date.now() - (firstPacketAt ?? startedAt)) / 1_000;
  const kilobitsPerSecond = (observed.videoBytes * 8) / 1_000 / Math.max(elapsedSeconds, 1);
  const framesPerSecond = (timestamps.size - midpoint.timestamps) / Math.max(elapsedSeconds, 1);
  console.log(
    `observed video packets=${observed.videoPackets} bytes=${observed.videoBytes} rate=${kilobitsPerSecond.toFixed(0)}kbps frames=${framesPerSecond.toFixed(1)}fps audio-packets=${observed.audioPackets} accessory-rtcp=${observed.accessoryReports}`,
  );
  console.log(
    `payload-types=[${[...observed.payloadTypes].join(',')}] ssrcs-match=${observed.ssrcs.size === 1 && observed.ssrcs.has(videoSsrc >>> 0)}`,
  );
  if (observed.videoPackets > 0) {
    if (!observed.payloadTypes.has(videoPayloadType) || observed.payloadTypes.size !== 1) {
      failures += 1;
      console.log(`negotiated payload type ${videoPayloadType} was not the only inbound payload type`);
    }
    if (!(observed.ssrcs.size === 1 && observed.ssrcs.has(videoSsrc >>> 0))) {
      failures += 1;
      console.log('inbound synchronisation source did not match the negotiated value');
    }
    if (kilobitsPerSecond > maxBitrate * 1.5) {
      failures += 1;
      console.log(`observed bitrate exceeded the negotiated maximum of ${maxBitrate}kbps`);
    }
    if (framesPerSecond > fps * 1.2) {
      failures += 1;
      console.log(`observed frame rate exceeded the negotiated ${fps}fps`);
    }
    if (observed.videoPackets === midpoint.videoPackets) {
      failures += 1;
      console.log('video stopped after the first packets instead of continuing across the RTCP interval');
    }
  }

  if (streamingProcesses !== undefined) {
    console.log(`adaptation processes while streaming=${streamingProcesses.length}`);
    if (streamingProcesses.length < 1) {
      failures += 1;
      console.log('no adaptation process was running while the session streamed');
    } else {
      const applied = {
        dimensions: streamingProcesses.some(({ args }) => args.includes(`${width}:${height}`)),
        frameRate: streamingProcesses.some(({ args }) => new RegExp(`-r\\s+${fps}\\b`).test(args)),
        bitrate: streamingProcesses.some(({ args }) => args.includes(`${maxBitrate}k`)),
      };
      console.log(
        `negotiated selection applied dimensions=${applied.dimensions} frame-rate=${applied.frameRate} bitrate=${applied.bitrate}`,
      );
      for (const [name, matched] of Object.entries(applied)) {
        if (!matched) {
          failures += 1;
          console.log(`adaptation did not apply the negotiated ${name}`);
        }
      }
    }
  }

  await client.setCharacteristics({
    [characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: tlv(1, tlv(1, sessionId, 2, END_SESSION)).toString('base64'),
  });
  await delay(5_000);
  const remainingProcesses = adaptationProcesses(parsed.get('homebridge-pid'));
  if (remainingProcesses !== undefined) {
    console.log(`adaptation processes after end-session=${remainingProcesses.length}`);
    if (remainingProcesses.length > 0) {
      failures += 1;
      console.log('an adaptation process survived the end of the session');
    }
  }
  const streaming = await client.getCharacteristics([characteristic(STREAMING_STATUS)]);
  const streamingStatus = untlv(Buffer.from(streaming.characteristics[0].value, 'base64')).get(1)?.[0];
  console.log(`end-session accepted streaming-status=${streamingStatus}`);
  if (streamingStatus !== 0) {
    failures += 1;
    console.log('accessory did not return to an available streaming status');
  }
} finally {
  video.socket.close();
  audio.socket.close();
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

if (failures > 0) {
  console.error(`live stream qualification reported ${failures} failing observation(s)`);
  process.exitCode = 1;
}

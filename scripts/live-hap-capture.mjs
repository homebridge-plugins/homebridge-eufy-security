/**
 * Live HomeKit media capture for visual inspection.
 *
 * Negotiates one HomeKit live session per camera against a running Homebridge instance, decrypts the
 * inbound SRTP with the keys this controller supplied, depacketizes H.264, and writes one MP4 plus one
 * still frame per camera so a maintainer can actually look at what HomeKit receives. It complements the
 * measurement harnesses, which deliberately never decrypt media.
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
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CAMERA_RTP_STREAM_MANAGEMENT = '00000110-0000-1000-8000-0026BB765291';
const BATTERY = '00000096-0000-1000-8000-0026BB765291';
const ACCESSORY_INFORMATION = '0000003E';
const MODEL = '00000021';
const SETUP_ENDPOINTS = '00000118';
const SELECTED_RTP_STREAM_CONFIGURATION = '00000117';

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
    const body = Buffer.isBuffer(pairs[index + 1]) ? pairs[index + 1] : Buffer.from([pairs[index + 1]]);
    for (let offset = 0; offset < Math.max(body.length, 1); offset += 255) {
      const fragment = body.subarray(offset, offset + 255);
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

const uint16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

const uint32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

/** RFC 3711 4.3.1 key derivation with AES-CM and a zero key-derivation rate. */
function deriveKey(masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0);
  iv[7] ^= label;
  return createCipheriv('aes-128-ctr', masterKey, iv).update(Buffer.alloc(length));
}

/** RFC 3711 4.1.1 AES-CM keystream for one packet index. */
function decryptPayload(sessionKey, sessionSalt, ssrc, rolloverCounter, sequence, payload) {
  const iv = Buffer.alloc(16);
  sessionSalt.copy(iv, 0);
  for (let byte = 0; byte < 4; byte += 1) {
    iv[4 + byte] ^= (ssrc >>> (24 - byte * 8)) & 0xff;
    iv[8 + byte] ^= (rolloverCounter >>> (24 - byte * 8)) & 0xff;
  }
  iv[12] ^= (sequence >>> 8) & 0xff;
  iv[13] ^= sequence & 0xff;
  return createCipheriv('aes-128-ctr', sessionKey, iv).update(payload);
}

function accessoryModel(accessory) {
  const information = accessory.services.find((service) =>
    service.type.toUpperCase().startsWith(ACCESSORY_INFORMATION),
  );
  const model = information?.characteristics.find((entry) => entry.type.toUpperCase().startsWith(MODEL));
  return typeof model?.value === 'string' ? model.value : 'unknown-model';
}

async function boundSocket() {
  const socket = createSocket('udp4');
  await new Promise((ready) => socket.bind(0, '0.0.0.0', ready));
  return { socket, port: socket.address().port };
}

/** One negotiated session, decrypted and muxed into a playable file. */
async function capture(client, accessory, settings) {
  const service = accessory.services.find((entry) => entry.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT);
  const characteristic = (prefix) =>
    `${accessory.aid}.${service.characteristics.find((entry) => entry.type.toUpperCase().startsWith(prefix)).iid}`;
  const video = await boundSocket();
  const audio = await boundSocket();
  const session = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
  const masterKey = randomBytes(16);
  const masterSalt = randomBytes(14);

  await client.setCharacteristics({
    [characteristic(SETUP_ENDPOINTS)]: tlv(
      1,
      session,
      3,
      tlv(1, 0, 2, Buffer.from(settings.address, 'utf8'), 3, uint16(video.port), 4, uint16(audio.port)),
      4,
      tlv(1, 0, 2, masterKey, 3, masterSalt),
      5,
      tlv(1, 0, 2, randomBytes(16), 3, randomBytes(14)),
    ).toString('base64'),
  });
  const negotiated = untlv(
    Buffer.from((await client.getCharacteristics([characteristic(SETUP_ENDPOINTS)])).characteristics[0].value, 'base64'),
  );
  if (negotiated.get(2)?.[0] !== 0) {
    video.socket.close();
    audio.socket.close();
    return { status: `endpoint setup refused with status ${negotiated.get(2)?.[0]}` };
  }
  const accessoryVideoPort = untlv(negotiated.get(3)).get(3).readUInt16LE(0);
  const videoSsrc = negotiated.get(6).readUInt32LE(0);
  const audioSsrc = negotiated.get(7).readUInt32LE(0);
  const sessionKey = deriveKey(masterKey, masterSalt, 0, 16);
  const sessionSalt = deriveKey(masterKey, masterSalt, 2, 14);

  const target = join(settings.output, `${accessoryModel(accessory).replaceAll(/[^A-Za-z0-9]+/g, '-')}-aid${accessory.aid}.mp4`);
  const muxer = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'h264', '-r', String(settings.fps), '-i', 'pipe:0', '-c:v', 'copy', '-movflags', '+faststart', target],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  );
  muxer.stdin.on('error', () => undefined);

  const startCode = Buffer.from([0, 0, 0, 1]);
  const observed = { packets: 0, nalUnits: 0, keyframes: 0 };
  let rolloverCounter = 0;
  let previousSequence;
  let fragment;
  let started = false;
  const emit = (nal) => {
    if (!started) {
      if ((nal[0] & 0x1f) !== 7) {
        return;
      }
      started = true;
    }
    observed.nalUnits += 1;
    if ((nal[0] & 0x1f) === 5) {
      observed.keyframes += 1;
    }
    muxer.stdin.write(Buffer.concat([startCode, nal]));
  };

  video.socket.on('message', (packet) => {
    const packetType = packet[1] & 0xff;
    if (packet.length < 22 || (packetType >= 200 && packetType <= 204)) {
      return;
    }
    const sequence = packet.readUInt16BE(2);
    if (previousSequence !== undefined && sequence < 0x4000 && previousSequence > 0xc000) {
      rolloverCounter += 1;
    }
    previousSequence = sequence;
    let headerLength = 12 + (packet[0] & 0x0f) * 4;
    if ((packet[0] & 0x10) !== 0) {
      headerLength += 4 + packet.readUInt16BE(headerLength + 2) * 4;
    }
    const payload = decryptPayload(
      sessionKey,
      sessionSalt,
      packet.readUInt32BE(8),
      rolloverCounter,
      sequence,
      packet.subarray(headerLength, packet.length - 10),
    );
    observed.packets += 1;
    const type = payload[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      emit(payload);
    } else if (type === 24) {
      let offset = 1;
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset);
        emit(payload.subarray(offset + 2, offset + 2 + size));
        offset += 2 + size;
      }
    } else if (type === 28) {
      if ((payload[1] & 0x80) !== 0) {
        fragment = [Buffer.from([(payload[0] & 0xe0) | (payload[1] & 0x1f)]), payload.subarray(2)];
      } else if (fragment) {
        fragment.push(payload.subarray(2));
      }
      if ((payload[1] & 0x40) !== 0 && fragment) {
        emit(Buffer.concat(fragment));
        fragment = undefined;
      }
    }
  });

  await client.setCharacteristics({
    [characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: tlv(
      1,
      tlv(1, session, 2, 1),
      2,
      tlv(
        1,
        0,
        2,
        tlv(1, 1, 2, 0, 3, 1),
        3,
        tlv(1, uint16(settings.width), 2, uint16(settings.height), 3, settings.fps),
        4,
        tlv(1, 99, 2, uint32(videoSsrc), 3, uint16(settings.bitrate), 4, Buffer.from([0, 0, 0x80, 0x3f])),
      ),
      3,
      tlv(
        1,
        2,
        2,
        tlv(1, 1, 2, 0, 3, 0, 4, 30),
        3,
        tlv(1, 110, 2, uint32(audioSsrc), 3, uint16(24), 4, Buffer.from([0, 0, 0x80, 0x3f]), 6, 13),
        4,
        0,
      ),
    ).toString('base64'),
  });

  const reports = setInterval(() => {
    const report = Buffer.alloc(32);
    report.writeUInt8(0x81, 0);
    report.writeUInt8(201, 1);
    report.writeUInt16BE(7, 2);
    report.writeUInt32BE(0x4f4f4f4f, 4);
    report.writeUInt32BE(videoSsrc >>> 0, 8);
    report.writeUInt32BE(previousSequence ?? 0, 16);
    video.socket.send(report, accessoryVideoPort, settings.address);
  }, 1_000);

  for (let waited = 0; waited < settings.warmup * 1_000 && observed.packets === 0; waited += 250) {
    await delay(250);
  }
  if (observed.packets > 0) {
    await delay(settings.seconds * 1_000);
  }
  clearInterval(reports);
  await client.setCharacteristics({
    [characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: tlv(1, tlv(1, session, 2, 0)).toString('base64'),
  });
  video.socket.close();
  audio.socket.close();
  muxer.stdin.end();
  await new Promise((finished) => muxer.on('exit', finished));

  if (observed.nalUnits === 0) {
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
  const cameras = accessories.filter((accessory) =>
    accessory.services.some((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT),
  );
  const selected = (
    parsed.has('aid')
      ? cameras.filter(({ aid }) => aid === Number(parsed.get('aid')))
      : parsed.has('battery')
        ? cameras
        : cameras.filter((accessory) => !accessory.services.some((service) => service.type.toUpperCase() === BATTERY))
  );
  console.log(`cameras=${cameras.length} selected=${selected.length}`);

  for (const accessory of selected) {
    const powered = accessory.services.some((service) => service.type.toUpperCase() === BATTERY) ? 'battery' : 'wired';
    console.log(`aid=${accessory.aid} model="${accessoryModel(accessory)}" power=${powered}`);
    const result = await capture(client, accessory, settings);
    console.log(
      `  ${result.status}${result.packets === undefined ? '' : ` packets=${result.packets} nal-units=${result.nalUnits} keyframes=${result.keyframes}`}`,
    );
  }
} finally {
  await client.removePairing(client.pairingProtocol.iOSDevicePairingID);
  client.close();
  console.log('removed the temporary controller pairing');
}

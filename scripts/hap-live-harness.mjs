/**
 * Shared HomeKit controller session mechanics for the live qualification harnesses in this directory.
 *
 * It owns everything a real controller needs to negotiate one live session against a running Homebridge
 * instance without a Home app: command-line options, HAP TLV encoding, camera selection, endpoint setup,
 * negotiated start, reconfigure and end commands, RTCP receiver reports, and measurement of the inbound
 * SRTP the accessory produces. `live-hap-stream-check.mjs`, `live-hap-capture.mjs`,
 * `live-hap-prepared-session-check.mjs`, and `live-hap-snapshot-check.mjs` consume it so one implementation
 * of the protocol carries every result.
 *
 * `MeasuredVideoStream` authenticates and decrypts inbound SRTP with the keys this controller supplied,
 * depacketizes H.264, and reports what the accessory actually encoded: negotiated payload type and
 * synchronisation source, authenticated packet and byte counts, frames, keyframes, and the sequence
 * parameter sets that carry coded dimensions, profile, and level. It never writes media to disk; a
 * caller that wants imagery passes `onNalUnit` and owns that output itself.
 *
 * The controller must hold one persistent HAP connection, because an accessory ties a streaming session
 * to the connection that wrote `SetupEndpoints` and tears the session down when it closes.
 *
 * Measurement is verified hermetically by `test/contracts/live-hap-harness.test.ts`.
 */
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';

export const CAMERA_RTP_STREAM_MANAGEMENT = '00000110-0000-1000-8000-0026BB765291';
export const BATTERY = '00000096-0000-1000-8000-0026BB765291';
export const ACCESSORY_INFORMATION = '0000003E';
export const MODEL = '00000021';
export const SETUP_ENDPOINTS = '00000118';
export const SELECTED_RTP_STREAM_CONFIGURATION = '00000117';
export const STREAMING_STATUS = '00000120';

/** Streaming status an accessory publishes for one stream management service. */
export const STREAMING_AVAILABLE = 0;
export const STREAMING_IN_USE = 1;
/** `SetupEndpoints` answer status: a busy service already carries a session. */
export const ENDPOINTS_ACCEPTED = 0;
export const ENDPOINTS_BUSY = 1;

const AES_CM_128_HMAC_SHA1_80 = 0;
const H264 = 0;
const AAC_ELD = 2;
const SESSION_COMMANDS = { end: 0, start: 1, reconfigure: 4 };
const SRTP_AUTHENTICATION_TAG = 10;
const PROFILE_NAMES = new Map([
  [66, 'baseline'],
  [77, 'main'],
  [100, 'high'],
]);

/** Long-option parsing shared by every harness in this directory. */
export function options(argv) {
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

export function required(parsed, name) {
  const value = parsed.get(name);
  if (!value) {
    throw new Error(`missing --${name}; see the header of this script for usage`);
  }
  return value;
}

/**
 * Pass, fail, and unverified accounting for one live run, including the summary it exits with, so every
 * check in this directory reports and fails a live observation the same way.
 */
export function observations(subject) {
  let failures = 0;
  let unverified = 0;
  return {
    check(passed, description) {
      console.log(`  ${passed ? 'pass' : 'FAIL'} ${description}`);
      if (!passed) {
        failures += 1;
      }
    },
    /** Records an observation this run could not make, reported without failing it. */
    unverified(description) {
      unverified += 1;
      console.log(description);
    },
    /** Prints what the run concluded and sets a failing exit code when any observation failed. */
    summarize() {
      if (unverified > 0) {
        console.log(`${subject} left ${unverified} observation(s) unverified`);
      }
      if (failures > 0) {
        console.error(`${subject} reported ${failures} failing observation(s)`);
        process.exitCode = 1;
      }
    },
  };
}

/** HAP TLV8 encoding, fragmenting any value longer than one record. */
export function tlv(...pairs) {
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

export function untlv(buffer) {
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

export function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

export function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** Product model of one accessory, which identifies a run without exposing the owner's chosen name. */
export function accessoryModel(accessory) {
  const information = accessory.services.find((service) =>
    service.type.toUpperCase().startsWith(ACCESSORY_INFORMATION),
  );
  const model = information?.characteristics.find((entry) => entry.type.toUpperCase().startsWith(MODEL));
  return typeof model?.value === 'string' ? model.value : 'unknown-model';
}

export function hasBattery(accessory) {
  return accessory.services.some((service) => service.type.toUpperCase() === BATTERY);
}

/**
 * Camera accessories a run may stream from. A live session wakes the camera, so battery accessories are
 * excluded unless they are asked for explicitly by `--battery` or by accessory id.
 */
export function selectCameras(accessories, { battery = false, aid } = {}) {
  const cameras = accessories.filter((accessory) =>
    accessory.services.some((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT),
  );
  if (aid !== undefined) {
    return cameras.filter((accessory) => accessory.aid === Number(aid));
  }
  return battery ? cameras : cameras.filter((accessory) => !hasBattery(accessory));
}

/** Camera RTP stream management services of one accessory, one per concurrent session it accepts. */
export function cameraStreamManagements(accessory) {
  return accessory.services.filter((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT);
}

/**
 * Characteristic address resolver for one of a camera's RTP stream management services. Each service
 * carries exactly one session, so a concurrent session must be negotiated on the next index.
 */
export function cameraCharacteristics(accessory, index = 0) {
  const management = cameraStreamManagements(accessory)[index];
  if (!management) {
    throw new Error(`accessory ${accessory.aid} has no camera RTP stream management service at index ${index}`);
  }
  return (prefix) => {
    const found = management.characteristics.find((entry) => entry.type.toUpperCase().startsWith(prefix));
    if (!found) {
      throw new Error(`camera service is missing characteristic ${prefix}`);
    }
    return `${accessory.aid}.${found.iid}`;
  };
}

export async function boundSocket() {
  const socket = createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', resolve);
  });
  return { socket, port: socket.address().port };
}

/** RFC 5761 multiplexes RTCP on the RTP port; packet types 200-204 are RTCP, not media. */
export function isRtcp(packet) {
  const packetType = packet[1] & 0xff;
  return packetType >= 200 && packetType <= 204;
}

/** A minimal RTCP receiver report, enough for an accessory's session keepalive. */
export function receiverReport(senderSsrc, sourceSsrc, highestSequence, packets) {
  const report = Buffer.alloc(32);
  report.writeUInt8(0x81, 0);
  report.writeUInt8(201, 1);
  report.writeUInt16BE(7, 2);
  report.writeUInt32BE(senderSsrc >>> 0, 4);
  report.writeUInt32BE(sourceSsrc >>> 0, 8);
  report.writeUInt32BE(highestSequence, 16);
  report.writeUInt32BE(packets, 28);
  return report;
}

/**
 * Adaptation processes an accessory owns, observed only when a Homebridge pid is supplied. Arguments are
 * returned for matching against a negotiated selection and must never be printed, because they carry
 * SRTP key material.
 */
export function adaptationProcesses(pid) {
  if (!pid) {
    return undefined;
  }
  return execFileSync('ps', ['-ax', '-o', 'ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf(' ');
      return { parent: Number(line.slice(0, separator)), args: line.slice(separator + 1) };
    })
    .filter(({ parent, args }) => parent === Number(pid) && args.includes('ffmpeg'));
}

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

/** Reads an H.264 bitstream after removing emulation prevention bytes. */
class BitReader {
  constructor(bytes) {
    const unescaped = [];
    for (let index = 0; index < bytes.length; index += 1) {
      if (index >= 2 && bytes[index] === 3 && bytes[index - 1] === 0 && bytes[index - 2] === 0) {
        continue;
      }
      unescaped.push(bytes[index]);
    }
    this.bytes = Uint8Array.from(unescaped);
    this.position = 0;
  }

  bit() {
    const byte = this.bytes[this.position >> 3] ?? 0;
    const value = (byte >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return value;
  }

  bits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + this.bit();
    }
    return value;
  }

  unsigned() {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) {
      zeros += 1;
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.bits(zeros);
  }

  signed() {
    const value = this.unsigned();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

function skipScalingLists(reader, count) {
  for (let list = 0; list < count; list += 1) {
    if (reader.bit() === 0) {
      continue;
    }
    let lastScale = 8;
    let nextScale = 8;
    for (let index = 0; index < (list < 6 ? 16 : 64); index += 1) {
      if (nextScale !== 0) {
        nextScale = (lastScale + reader.signed() + 256) % 256;
      }
      lastScale = nextScale === 0 ? lastScale : nextScale;
    }
  }
}

/**
 * Coded dimensions, profile, and level an accessory actually encoded, read from one sequence parameter
 * set. This is the only evidence that a negotiated selection reached the wire rather than only the
 * adaptation command line. Profiles use HomeKit's vocabulary, so a constrained-baseline stream is
 * reported as `baseline`.
 */
export function describeSequenceParameterSet(nal) {
  const reader = new BitReader(nal.subarray(1));
  const profileIdc = reader.bits(8);
  reader.bits(8);
  const levelIdc = reader.bits(8);
  reader.unsigned();
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = reader.unsigned();
    if (chromaFormatIdc === 3) {
      separateColourPlane = reader.bit();
    }
    reader.unsigned();
    reader.unsigned();
    reader.bit();
    if (reader.bit() === 1) {
      skipScalingLists(reader, chromaFormatIdc === 3 ? 12 : 8);
    }
  }
  reader.unsigned();
  const pictureOrderType = reader.unsigned();
  if (pictureOrderType === 0) {
    reader.unsigned();
  } else if (pictureOrderType === 1) {
    reader.bit();
    reader.signed();
    reader.signed();
    const cycle = reader.unsigned();
    for (let index = 0; index < cycle; index += 1) {
      reader.signed();
    }
  }
  reader.unsigned();
  reader.bit();
  const widthInMacroblocks = reader.unsigned() + 1;
  const heightInMapUnits = reader.unsigned() + 1;
  const frameMacroblocksOnly = reader.bit();
  if (frameMacroblocksOnly === 0) {
    reader.bit();
  }
  reader.bit();
  const crop = { left: 0, right: 0, top: 0, bottom: 0 };
  if (reader.bit() === 1) {
    crop.left = reader.unsigned();
    crop.right = reader.unsigned();
    crop.top = reader.unsigned();
    crop.bottom = reader.unsigned();
  }
  const monochrome = chromaFormatIdc === 0 || separateColourPlane === 1;
  const cropUnitX = monochrome ? 1 : chromaFormatIdc === 3 ? 1 : 2;
  const cropUnitY = (monochrome ? 1 : chromaFormatIdc === 1 ? 2 : 1) * (2 - frameMacroblocksOnly);
  return {
    width: widthInMacroblocks * 16 - cropUnitX * (crop.left + crop.right),
    height: (2 - frameMacroblocksOnly) * heightInMapUnits * 16 - cropUnitY * (crop.top + crop.bottom),
    profile: PROFILE_NAMES.get(profileIdc) ?? `profile-${profileIdc}`,
    level: `${Math.floor(levelIdc / 10)}.${levelIdc % 10}`,
  };
}

/**
 * Authenticated, decrypted measurement of one negotiated HomeKit video stream. Every counter describes
 * only packets that carried the negotiated synchronisation source and passed SRTP authentication with
 * the key this controller supplied.
 */
export class MeasuredVideoStream {
  constructor({ masterKey, masterSalt, ssrc, onNalUnit }) {
    this.expectedSsrc = ssrc >>> 0;
    this.sessionKey = deriveKey(masterKey, masterSalt, 0, 16);
    this.authenticationKey = deriveKey(masterKey, masterSalt, 1, 20);
    this.sessionSalt = deriveKey(masterKey, masterSalt, 2, 14);
    this.onNalUnit = onNalUnit;
    this.counters = {
      packets: 0,
      bytes: 0,
      unauthenticated: 0,
      foreign: 0,
      rtcpPackets: 0,
      frames: 0,
      keyframes: 0,
      highestSequence: 0,
    };
    this.payloadTypes = new Set();
    this.ssrcs = new Set();
    this.timestamps = new Set();
    this.observedParameterSets = [];
    this.rolloverCounter = 0;
    this.previousSequence = undefined;
    this.fragment = undefined;
    this.instantaneousRefresh = false;
  }

  /** Classifies and measures one inbound datagram, returning what it was. */
  accept(packet) {
    if (packet.length < 12 + SRTP_AUTHENTICATION_TAG) {
      return 'ignored';
    }
    if (isRtcp(packet)) {
      this.counters.rtcpPackets += 1;
      return 'rtcp';
    }
    const ssrc = packet.readUInt32BE(8);
    if (ssrc !== this.expectedSsrc) {
      this.counters.foreign += 1;
      this.ssrcs.add(ssrc);
      return 'foreign';
    }
    const sequence = packet.readUInt16BE(2);
    const rolloverCounter =
      this.previousSequence !== undefined && sequence < 0x4000 && this.previousSequence > 0xc000
        ? this.rolloverCounter + 1
        : this.rolloverCounter;
    if (!this.authenticate(packet, rolloverCounter)) {
      this.counters.unauthenticated += 1;
      return 'unauthenticated';
    }
    this.rolloverCounter = rolloverCounter;
    this.previousSequence = sequence;
    this.counters.packets += 1;
    this.counters.bytes += packet.length;
    this.counters.highestSequence = Math.max(this.counters.highestSequence, sequence);
    this.payloadTypes.add(packet[1] & 0x7f);
    this.ssrcs.add(ssrc);
    this.timestamps.add(packet.readUInt32BE(4));
    this.depacketize(this.decrypt(packet, sequence));
    if ((packet[1] & 0x80) !== 0) {
      this.counters.frames += 1;
      if (this.instantaneousRefresh) {
        this.counters.keyframes += 1;
        this.instantaneousRefresh = false;
      }
      if (this.observedParameterSets.length > 0) {
        this.observedParameterSets.at(-1).frames += 1;
      }
    }
    return 'video';
  }

  /** RFC 3711 4.2 HMAC-SHA1-80 over the packet and the rollover counter it would commit. */
  authenticate(packet, rolloverCounter) {
    const rollover = Buffer.alloc(4);
    rollover.writeUInt32BE(rolloverCounter);
    const expected = createHmac('sha1', this.authenticationKey)
      .update(Buffer.concat([packet.subarray(0, packet.length - SRTP_AUTHENTICATION_TAG), rollover]))
      .digest()
      .subarray(0, SRTP_AUTHENTICATION_TAG);
    return expected.equals(packet.subarray(packet.length - SRTP_AUTHENTICATION_TAG));
  }

  decrypt(packet, sequence) {
    let headerLength = 12 + (packet[0] & 0x0f) * 4;
    if ((packet[0] & 0x10) !== 0) {
      headerLength += 4 + packet.readUInt16BE(headerLength + 2) * 4;
    }
    return decryptPayload(
      this.sessionKey,
      this.sessionSalt,
      packet.readUInt32BE(8),
      this.rolloverCounter,
      sequence,
      packet.subarray(headerLength, packet.length - SRTP_AUTHENTICATION_TAG),
    );
  }

  /** RFC 6184 single NAL unit, aggregation, and fragmentation modes. */
  depacketize(payload) {
    const type = payload[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.emit(payload);
      return;
    }
    if (type === 24) {
      let offset = 1;
      while (offset + 2 <= payload.length) {
        const size = payload.readUInt16BE(offset);
        this.emit(payload.subarray(offset + 2, offset + 2 + size));
        offset += 2 + size;
      }
      return;
    }
    if (type !== 28) {
      return;
    }
    if ((payload[1] & 0x80) !== 0) {
      this.fragment = [Buffer.from([(payload[0] & 0xe0) | (payload[1] & 0x1f)]), payload.subarray(2)];
    } else if (this.fragment) {
      this.fragment.push(payload.subarray(2));
    }
    if ((payload[1] & 0x40) !== 0 && this.fragment) {
      this.emit(Buffer.concat(this.fragment));
      this.fragment = undefined;
    }
  }

  emit(nal) {
    const type = nal[0] & 0x1f;
    if (type === 5) {
      this.instantaneousRefresh = true;
    }
    if (type === 7) {
      const described = describeSequenceParameterSet(nal);
      const previous = this.observedParameterSets.at(-1);
      if (
        !previous ||
        previous.width !== described.width ||
        previous.height !== described.height ||
        previous.profile !== described.profile ||
        previous.level !== described.level
      ) {
        this.observedParameterSets.push({ ...described, frames: 0 });
      }
    }
    this.onNalUnit?.(nal);
  }

  /**
   * An immutable snapshot, so a caller can difference two points of a session. Counters are cumulative
   * and safe to subtract; the payload-type and synchronisation-source sets are deliberately whole-session,
   * because an identity that appeared once must stay visible in every later window.
   */
  get report() {
    return {
      ...this.counters,
      payloadTypes: new Set(this.payloadTypes),
      ssrcs: new Set(this.ssrcs),
      distinctTimestamps: this.timestamps.size,
      parameterSets: this.observedParameterSets.map((entry) => ({ ...entry })),
    };
  }
}

/**
 * One negotiated live session on one camera, driven the way a controller drives it: endpoint setup with
 * controller-supplied SRTP keys, a selected configuration, keepalive receiver reports, an optional
 * mid-session reconfiguration, and an explicit end.
 */
export class LiveSession {
  constructor(client, accessory, address, { onNalUnit, streamIndex = 0 } = {}) {
    this.client = client;
    this.accessory = accessory;
    this.address = address;
    this.characteristic = cameraCharacteristics(accessory, streamIndex);
    this.streamIndex = streamIndex;
    this.onNalUnit = onNalUnit;
    this.identifier = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
    this.masterKey = randomBytes(16);
    this.masterSalt = randomBytes(14);
    this.selection = undefined;
    this.reports = undefined;
  }

  /** Reserves controller ports and writes `SetupEndpoints`, returning the accessory's answer. */
  async setup() {
    this.video = await boundSocket();
    this.audio = await boundSocket();
    await this.client.setCharacteristics({
      [this.characteristic(SETUP_ENDPOINTS)]: tlv(
        1,
        this.identifier,
        3,
        tlv(1, 0, 2, Buffer.from(this.address, 'utf8'), 3, uint16(this.video.port), 4, uint16(this.audio.port)),
        4,
        tlv(1, AES_CM_128_HMAC_SHA1_80, 2, this.masterKey, 3, this.masterSalt),
        5,
        tlv(1, AES_CM_128_HMAC_SHA1_80, 2, randomBytes(16), 3, randomBytes(14)),
      ).toString('base64'),
    });
    const response = await this.client.getCharacteristics([this.characteristic(SETUP_ENDPOINTS)]);
    const negotiated = untlv(Buffer.from(response.characteristics[0].value, 'base64'));
    this.status = negotiated.get(2)?.[0];
    if (this.status !== 0) {
      return { status: this.status };
    }
    this.accessoryVideoPort = untlv(negotiated.get(3)).get(3).readUInt16LE(0);
    this.videoSsrc = negotiated.get(6).readUInt32LE(0);
    this.audioSsrc = negotiated.get(7).readUInt32LE(0);
    return { status: 0, accessoryVideoPort: this.accessoryVideoPort, videoSsrc: this.videoSsrc >>> 0 };
  }

  /** Starts measuring inbound media, then writes a selected configuration and begins keepalive reports. */
  async start(selection) {
    this.selection = selection;
    this.measured = new MeasuredVideoStream({
      masterKey: this.masterKey,
      masterSalt: this.masterSalt,
      ssrc: this.videoSsrc,
      ...(this.onNalUnit ? { onNalUnit: this.onNalUnit } : {}),
    });
    this.audioPackets = 0;
    this.video.socket.on('message', (packet) => this.measured.accept(packet));
    this.audio.socket.on('message', (packet) => {
      if (!isRtcp(packet)) {
        this.audioPackets += 1;
      }
    });
    this.startedAt = Date.now();
    await this.write(SESSION_COMMANDS.start, selection);
    this.reports = setInterval(() => this.report(), 1_000);
    this.reports.unref?.();
  }

  /** Asks the accessory to change the negotiated video while the same session continues. */
  async reconfigure(selection) {
    this.selection = { ...this.selection, ...selection };
    await this.write(SESSION_COMMANDS.reconfigure, this.selection);
  }

  async end() {
    clearInterval(this.reports);
    this.reports = undefined;
    await this.client.setCharacteristics({
      [this.characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: tlv(
        1,
        tlv(1, this.identifier, 2, SESSION_COMMANDS.end),
      ).toString('base64'),
    });
  }

  close() {
    clearInterval(this.reports);
    this.video?.socket.close();
    this.audio?.socket.close();
  }

  /** Streaming status the accessory publishes: 0 is available. */
  async streamingStatus() {
    const response = await this.client.getCharacteristics([this.characteristic(STREAMING_STATUS)]);
    return untlv(Buffer.from(response.characteristics[0].value, 'base64')).get(1)?.[0];
  }

  report() {
    if (!this.measured) {
      return;
    }
    const { highestSequence, packets } = this.measured.report;
    this.video.socket.send(
      receiverReport(0x4f4f4f4f, this.videoSsrc, highestSequence, packets),
      this.accessoryVideoPort,
      this.address,
    );
  }

  /**
   * Writes one session-control command. An accessory answers a refused write with a per-characteristic
   * status rather than a transport error, so a refusal is raised here instead of resolving as accepted and
   * being reported later as a session that merely produced nothing.
   */
  async write(command, selection) {
    const video = tlv(
      1,
      H264,
      2,
      tlv(1, 1, 2, 0, 3, 1),
      3,
      tlv(1, uint16(selection.width), 2, uint16(selection.height), 3, selection.fps),
      4,
      tlv(
        1,
        selection.videoPayloadType,
        2,
        uint32(this.videoSsrc),
        3,
        uint16(selection.bitrate),
        4,
        Buffer.from([0, 0, 0x80, 0x3f]),
      ),
    );
    const audio = tlv(
      1,
      AAC_ELD,
      2,
      tlv(1, 1, 2, 0, 3, 0, 4, 30),
      3,
      tlv(
        1,
        selection.audioPayloadType,
        2,
        uint32(this.audioSsrc),
        3,
        uint16(24),
        4,
        Buffer.from([0, 0, 0x80, 0x3f]),
        6,
        13,
      ),
      4,
      0,
    );
    const response = await this.client.setCharacteristics({
      [this.characteristic(SELECTED_RTP_STREAM_CONFIGURATION)]: tlv(
        1,
        tlv(1, this.identifier, 2, command),
        2,
        video,
        3,
        audio,
      ).toString('base64'),
    });
    const refused = (response?.characteristics ?? []).find((entry) => (entry.status ?? 0) !== 0);
    if (refused) {
      throw new Error(`accessory refused the session command with status ${refused.status}`);
    }
  }
}

/** Waits for a predicate, polling at a bounded interval, and reports how long it took. */
export async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

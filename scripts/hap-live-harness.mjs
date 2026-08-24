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
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

export const CAMERA_RTP_STREAM_MANAGEMENT = '00000110-0000-1000-8000-0026BB765291';
export const BATTERY = '00000096-0000-1000-8000-0026BB765291';
export const ACCESSORY_INFORMATION = '0000003E';
export const MODEL = '00000021';
const SERIAL_NUMBER = '00000030';
export const SETUP_ENDPOINTS = '00000118';
export const SELECTED_RTP_STREAM_CONFIGURATION = '00000117';
export const SUPPORTED_VIDEO_STREAM_CONFIGURATION = '00000114';
export const STREAMING_STATUS = '00000120';

/** Streaming status an accessory publishes for one stream management service. */
export const STREAMING_AVAILABLE = 0;
export const STREAMING_IN_USE = 1;
/** `SetupEndpoints` answer status: a busy service already carries a session. */
export const ENDPOINTS_ACCEPTED = 0;
export const ENDPOINTS_BUSY = 1;
export const ENDPOINTS_REFUSED = 2;

const AES_CM_128_HMAC_SHA1_80 = 0;
const H264 = 0;
const AAC_ELD = 2;
const NON_INTERLEAVED = 0;
const SESSION_COMMANDS = { end: 0, start: 1, reconfigure: 4 };
const SRTP_AUTHENTICATION_TAG = 10;
/**
 * HomeKit's H.264 profile and level vocabulary. A position in each list is the identifier that carries
 * that name on the wire, both in what an accessory advertises and in what a controller selects.
 */
const HAP_PROFILES = ['baseline', 'main', 'high'];
const HAP_LEVELS = ['3.1', '3.2', '4.0'];
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

/**
 * The separate entries of one repeated TLV type, split on the zero-length delimiter HAP writes between
 * them. `untlv` concatenates a repeated type, which reads a list of single-byte identifiers correctly and
 * loses the boundaries of a list of structures, so a caller that needs the entries reads them here. A
 * repeated record that follows its own type without a delimiter is a value longer than one record and is
 * reassembled rather than treated as another entry.
 */
export function untlvList(buffer, type) {
  const entries = [];
  let offset = 0;
  let previousType = -1;
  let delimited = true;
  while (offset + 2 <= buffer.length) {
    const recordType = buffer[offset];
    const length = buffer[offset + 1];
    const fragment = buffer.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    if (recordType === 0 && length === 0) {
      delimited = true;
      continue;
    }
    if (recordType === type) {
      if (previousType === type && !delimited) {
        entries[entries.length - 1] = Buffer.concat([entries.at(-1), fragment]);
      } else {
        entries.push(fragment);
      }
    }
    previousType = recordType;
    delimited = false;
  }
  return entries;
}

/**
 * The video codec configurations one accessory advertises in `SupportedVideoStreamConfiguration`, in
 * HomeKit's own vocabulary. This is the accessory's complete statement of what a controller may select,
 * and an accessory validates a selection against nothing, so a run reads it to know that its request is
 * one the accessory offered rather than one it merely tolerated.
 */
export function describeSupportedVideoStreamConfiguration(value) {
  return untlvList(Buffer.from(value, 'base64'), 1).map((configuration) => {
    const fields = untlv(configuration);
    const parameters = untlv(fields.get(2) ?? Buffer.alloc(0));
    const codec = fields.get(1)?.[0];
    return {
      codec: codec === H264 ? 'h264' : `codec-${codec}`,
      profiles: [...(parameters.get(1) ?? [])].map((identifier) => HAP_PROFILES[identifier] ?? `profile-${identifier}`),
      levels: [...(parameters.get(2) ?? [])].map((identifier) => HAP_LEVELS[identifier] ?? `level-${identifier}`),
      packetizationMode: parameters.get(3)?.[0],
      resolutions: untlvList(configuration, 3).map((entry) => {
        const attributes = untlv(entry);
        return {
          width: attributes.get(1).readUInt16LE(0),
          height: attributes.get(2).readUInt16LE(0),
          fps: attributes.get(3)[0],
        };
      }),
    };
  });
}

/**
 * The parts of a selection no single advertised configuration covers, empty when the accessory offered it.
 * Every part must be covered by the same configuration, because a profile from one and a resolution from
 * another is a combination the accessory never advertised. A frame rate at or below an advertised
 * resolution's rate is covered, because a controller legitimately asks for fewer frames than a resolution
 * can carry.
 */
export function unadvertisedSelection(configurations, selection) {
  const h264 = configurations.filter((configuration) => configuration.codec === 'h264');
  if (h264.length === 0) {
    return ['any H.264 configuration'];
  }
  const shortfalls = h264.map((configuration) => {
    const missing = [];
    if (!configuration.profiles.includes(selection.profile)) {
      missing.push(`profile ${selection.profile}`);
    }
    if (!configuration.levels.includes(selection.level)) {
      missing.push(`level ${selection.level}`);
    }
    if (
      !configuration.resolutions.some(
        (resolution) =>
          resolution.width === selection.width &&
          resolution.height === selection.height &&
          selection.fps <= resolution.fps,
      )
    ) {
      missing.push(`${selection.width}x${selection.height}@${selection.fps}`);
    }
    return missing;
  });
  return shortfalls.reduce((fewest, missing) => (missing.length < fewest.length ? missing : fewest));
}

/** Reports one accessory's advertised video vocabulary, which bounds every selection a run may request. */
export function reportAdvertisedVideo(configurations) {
  for (const configuration of configurations) {
    console.log(
      `advertised codec=${configuration.codec} profiles=[${configuration.profiles.join(',')}]` +
        ` levels=[${configuration.levels.join(',')}] packetization-mode=${configuration.packetizationMode}` +
        ` resolutions=[${configuration.resolutions
          .map((entry) => `${entry.width}x${entry.height}@${entry.fps}`)
          .join(',')}]`,
    );
  }
}

/**
 * Refuses a selection outside the advertised matrix before anything is negotiated. An accessory answers an
 * unadvertised selection without complaint, so a run that requested one would measure a combination no
 * controller would ever ask for and report it as evidence.
 */
export function refuseUnadvertised(configurations, selection, label) {
  const missing = unadvertisedSelection(configurations, selection);
  if (missing.length > 0) {
    throw new Error(`the accessory does not advertise ${missing.join(' or ')} for the ${label}`);
  }
}

/** The identifier that carries one name on the wire, refusing a name HomeKit has no vocabulary for. */
function identifier(names, name, kind) {
  const index = names.indexOf(name);
  if (index < 0) {
    throw new Error(`unknown H.264 ${kind} ${name}; the HomeKit vocabulary is ${names.join(', ')}`);
  }
  return index;
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
 * Serial number one accessory reports. Private to this module: a serial identifies a physical device, so
 * it may be matched against a maintainer's own argument but never returned to a caller that prints.
 */
function accessorySerial(accessory) {
  const information = accessory.services.find((service) =>
    service.type.toUpperCase().startsWith(ACCESSORY_INFORMATION),
  );
  const serial = information?.characteristics.find((entry) => entry.type.toUpperCase().startsWith(SERIAL_NUMBER));
  return typeof serial?.value === 'string' ? serial.value : undefined;
}

/** Opaque retained-image filename for an accessory, without exposing its physical serial to callers. */
export function retainedSnapshotName(accessory) {
  const serial = accessorySerial(accessory);
  return serial ? `${createHash('sha256').update(serial).digest('hex')}.jpg` : undefined;
}

/**
 * Camera accessories a run may stream from. A live session wakes the camera, so battery accessories are
 * excluded unless they are asked for explicitly by `--battery`, by accessory id, or by serial. A serial
 * is how a run that also drives the device through the SDK proves both halves address one camera.
 */
export function selectCameras(accessories, { battery = false, aid, serial } = {}) {
  const cameras = accessories.filter((accessory) =>
    accessory.services.some((service) => service.type.toUpperCase() === CAMERA_RTP_STREAM_MANAGEMENT),
  );
  if (serial !== undefined) {
    return cameras.filter((accessory) => accessorySerial(accessory) === serial);
  }
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

/**
 * What one of a camera's stream management services advertises for video, read from the accessory itself
 * so a run is judged against the accessory's own statement rather than a copy of it kept here.
 */
export async function advertisedVideo(client, accessory, streamIndex = 0) {
  const characteristic = cameraCharacteristics(accessory, streamIndex)(SUPPORTED_VIDEO_STREAM_CONFIGURATION);
  const response = await client.getCharacteristics([characteristic]);
  return describeSupportedVideoStreamConfiguration(response.characteristics[0].value);
}

/**
 * Byte length of a log file now, so a run only ever reads the section it goes on to append. Returns
 * nothing when no path was supplied, which callers report as an unverified observation.
 */
export function logMark(path) {
  if (!path) {
    return undefined;
  }
  return { path, offset: statSync(path).size };
}

/** The non-empty lines one run appended to a marked log, without exposing any of them to a caller. */
export function appendedLines(mark) {
  return readFileSync(mark.path, 'utf8')
    .slice(mark.offset)
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/**
 * The bounded condition codes a Homebridge log section reported. The plugin prints one `[code] summary`
 * line per condition transition, so the codes are readable without reading a line of context.
 */
export function conditionCodes(lines) {
  return new Set(lines.flatMap((line) => [...line.matchAll(/\[([a-z][a-z0-9-]+)\]/g)].map((match) => match[1])));
}

/**
 * Whether an image is a structurally complete JPEG: a start-of-image marker and an end-of-image marker.
 * Enough to tell a served or retained image from a truncated one without decoding it.
 */
export function isStructuralJpeg(image) {
  return (
    image.length > 4 &&
    image.subarray(0, 3).toString('hex') === 'ffd8ff' &&
    image.subarray(-2).toString('hex') === 'ffd9'
  );
}

/**
 * One HomeKit snapshot request, the same `/resource` request a Home app tile issues. Only the length, a
 * short digest, and structural validity are returned, so no caller can print camera imagery.
 */
export async function snapshotImage(client, aid, { width = 1280, height = 720 } = {}) {
  const image = await client.getImage(width, height, aid);
  return {
    bytes: image.length,
    digest: createHash('sha256').update(image).digest('hex').slice(0, 12),
    structural: isStructuralJpeg(image),
  };
}

/**
 * The video selection one run negotiates, from its options. Profile and level belong to the selection
 * because they are written to the wire and then judged against what the accessory coded.
 */
export function videoSelection(parsed) {
  return {
    width: Number(parsed.get('width') ?? 1280),
    height: Number(parsed.get('height') ?? 720),
    fps: Number(parsed.get('fps') ?? 30),
    bitrate: Number(parsed.get('bitrate') ?? 299),
    profile: parsed.get('profile') ?? 'main',
    level: parsed.get('level') ?? '3.1',
    videoPayloadType: 99,
    audioPayloadType: 110,
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
 * The selected video configuration a controller writes for one session command. Profile and level are
 * carried from the selection rather than pinned, because a run that judges coded fidelity must be able to
 * request any combination the accessory advertised.
 */
export function selectedVideoConfiguration(selection, ssrc) {
  return tlv(
    1,
    H264,
    2,
    tlv(
      1,
      identifier(HAP_PROFILES, selection.profile, 'profile'),
      2,
      identifier(HAP_LEVELS, selection.level, 'level'),
      3,
      NON_INTERLEAVED,
    ),
    3,
    tlv(1, uint16(selection.width), 2, uint16(selection.height), 3, selection.fps),
    4,
    tlv(
      1,
      selection.videoPayloadType,
      2,
      uint32(ssrc),
      3,
      uint16(selection.bitrate),
      4,
      Buffer.from([0, 0, 0x80, 0x3f]),
    ),
  );
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
    const video = selectedVideoConfiguration(selection, this.videoSsrc);
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

/**
 * Waits for a predicate, polling at a bounded interval, and reports how long it took. The predicate is
 * awaited, so a condition that has to be read from the accessory is expressed directly rather than
 * through a variable a caller keeps in step.
 */
export async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return Date.now() - startedAt;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/**
 * What one session carried between two of its snapshots, so a window is judged on its own. Numeric
 * counters are differenced; the payload-type and synchronisation-source sets stay whole-session, because
 * an identity that appeared once must still fail a later window. The parameter set in force at the
 * earlier snapshot is retained, because a window that codes no new set is still coding that one.
 */
export function measuredWindow(current, previous) {
  const window = {
    payloadTypes: current.payloadTypes,
    ssrcs: current.ssrcs,
    parameterSets: current.parameterSets.slice(Math.max(previous.parameterSets.length - 1, 0)),
  };
  for (const [name, value] of Object.entries(current)) {
    if (typeof value === 'number') {
      window[name] = value - previous[name];
    }
  }
  return window;
}

/**
 * Reports and judges what one measured window carried against the selection it was negotiated from,
 * without exposing any media content. Rates are judged on the window; keyframe presence and refresh
 * cadence are judged on `session`, the cumulative report the window belongs to, because a window shorter
 * than one group of pictures legitimately contains no keyframe of its own.
 *
 * Every coded parameter set in the window must carry exactly the negotiated dimensions, profile, and
 * level. HomeKit negotiates a stream a controller has committed to decode, so a lower profile or level is
 * a fidelity failure rather than a courtesy, and one correct set later in a window does not excuse a wrong
 * set earlier in it. Constrained Baseline is the realization of a Baseline selection and is reported as
 * `baseline`, which is the one substitution the negotiated contract admits.
 */
export function judgeWindow(results, { label, window, seconds, expected, session = window }) {
  const kilobitsPerSecond = (window.bytes * 8) / 1_000 / Math.max(seconds, 1);
  const framesPerSecond = window.frames / Math.max(seconds, 1);
  console.log(
    `${label} packets=${window.packets} bytes=${window.bytes} rate=${kilobitsPerSecond.toFixed(0)}kbps` +
      ` frames=${window.frames} (${framesPerSecond.toFixed(1)}fps) keyframes=${window.keyframes}` +
      ` unauthenticated=${window.unauthenticated} foreign-ssrc=${window.foreign} accessory-rtcp=${window.rtcpPackets}`,
  );
  console.log(
    `${label} coded=${window.parameterSets
      .map((set) => `${set.width}x${set.height} ${set.profile}@${set.level} frames=${set.frames}`)
      .join(' -> ')}`,
  );
  results.check(window.packets > 0, `${label} delivered authenticated video`);
  results.check(window.unauthenticated === 0, `${label} authenticated every packet with the negotiated SRTP key`);
  results.check(window.foreign === 0, `${label} sent nothing from another synchronisation source`);
  results.check(
    window.payloadTypes.size === 1 && window.payloadTypes.has(expected.videoPayloadType),
    `${label} used only the negotiated payload type ${expected.videoPayloadType}`,
  );
  results.check(session.keyframes > 0, `${label} delivered at least one keyframe`);
  if (session.keyframes > 1) {
    results.check(
      session.frames / session.keyframes <= expected.fps * 3,
      `${label} refreshed inside the negotiated group of pictures`,
    );
  }
  results.check(
    kilobitsPerSecond <= expected.bitrate * 1.5,
    `${label} stayed inside the negotiated ${expected.bitrate}kbps`,
  );
  results.check(framesPerSecond <= expected.fps * 1.2, `${label} stayed inside the negotiated ${expected.fps}fps`);
  const coded = window.parameterSets;
  results.check(
    coded.length > 0 && coded.every((set) => set.width === expected.width && set.height === expected.height),
    `${label} coded the negotiated ${expected.width}x${expected.height}`,
  );
  results.check(
    coded.length > 0 && coded.every((set) => set.profile === expected.profile && set.level === expected.level),
    `${label} coded exactly the negotiated ${expected.profile} profile at level ${expected.level}`,
  );
}

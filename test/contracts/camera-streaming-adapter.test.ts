import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import type { AvailabilityObservation, CameraActions } from '@mega-yfue/eufy-sdk';
import { LiveSnapshotUnavailableError, StoredSnapshotUnavailableError, unreflectedMembers } from '@mega-yfue/eufy-sdk';
import {
  Accessory,
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  Characteristic,
  decode as decodeTlv,
  decodeWithLists as decodeTlvWithLists,
  encode as encodeTlv,
  EventTriggerOption,
  H264Level,
  H264Profile,
  HAPStatus,
  HapStatusError,
  HDSProtocolError,
  HDSProtocolSpecificErrorReason,
  MediaContainerType,
  readUInt16,
  Service,
  SRTPCryptoSuites,
  StreamRequestTypes,
  uuid,
  VideoCodecType,
  writeUInt16,
} from '@homebridge/hap-nodejs';
import type {
  CameraRecordingDelegate,
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamRequest,
  PrepareStreamResponse,
  RecordingPacket,
  StreamingRequest,
} from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterAttachmentContext } from '../../src/homekit/adapter.js';
import type {
  AdaptedRecording,
  LiveMediaAdapter,
  LiveMediaSource,
  LiveMediaTransport,
  LiveSessionOutcome,
  NegotiatedRecording,
  PreparedLiveMedia,
  RecordedFragment,
  RecordingMediaAdapter,
  RecordingMediaSource,
  RecordingOutcome,
} from '../../src/media/contracts.js';
import type { DeviceMemberEvidence } from '../../src/device/member-evidence.js';
import { CAMERA_STREAMING_ADAPTER } from '../../src/homekit/adapters/camera-streaming.js';
import { DOORBELL_ADAPTER } from '../../src/homekit/adapters/doorbell.js';
import { MOTION_ADAPTER } from '../../src/homekit/adapters/motion.js';
import { SnapshotAcquisition, type LastSuccessfulImages } from '../../src/media/snapshot.js';

const HAP = {
  Service,
  Characteristic,
  HAPStatus,
  HapStatusError,
  CameraController,
  H264Profile,
  H264Level,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  SRTPCryptoSuites,
  VideoCodecType,
  MediaContainerType,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioBitrate,
  EventTriggerOption,
  HDSProtocolError,
  HDSProtocolSpecificErrorReason,
};

function callPrepare(delegate: CameraStreamingDelegate, request: PrepareStreamRequest): Promise<PrepareStreamResponse> {
  return new Promise((resolve, reject) => {
    delegate.prepareStream(request, (error, response) => {
      if (error || !response) {
        reject(error ?? new Error('missing response'));
      } else {
        resolve(response);
      }
    });
  });
}

function callStream(delegate: CameraStreamingDelegate, request: StreamingRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    delegate.handleStreamRequest(request, (error) => (error ? reject(error) : resolve()));
  });
}

function callSnapshot(delegate: CameraStreamingDelegate): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    delegate.handleSnapshotRequest({} as never, (error, buffer) => {
      if (error || !buffer) {
        reject(error ?? new Error('missing snapshot'));
      } else {
        resolve(buffer);
      }
    });
  });
}

function prepareRequest(sessionID = 'synthetic-session'): PrepareStreamRequest {
  return {
    sessionID,
    sourceAddress: '192.0.2.20',
    targetAddress: '192.0.2.10',
    addressVersion: 'ipv4',
    video: {
      port: 50100,
      srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
      srtp_key: Buffer.alloc(16, 1),
      srtp_salt: Buffer.alloc(14, 2),
    },
    audio: {
      port: 50101,
      srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
      srtp_key: Buffer.alloc(16, 3),
      srtp_salt: Buffer.alloc(14, 4),
    },
  };
}

const SNAPSHOT_SERIAL = 'SYNTHETIC0000000001';

/** The images this package ships for a camera that cannot be photographed, and for one that is off. */
const PACKAGED_PLACEHOLDER = readFileSync(new URL('../../media/Snapshot-Unavailable.jpg', import.meta.url));
const PACKAGED_DISABLED_IMAGE = readFileSync(new URL('../../media/camera-disabled.jpg', import.meta.url));
const PACKAGED_OFFLINE_IMAGE = readFileSync(new URL('../../media/camera-offline.jpg', import.meta.url));

const SETUP_ENDPOINTS_SUCCESS = 0;
const SETUP_ENDPOINTS_BUSY = 1;
const SETUP_ENDPOINTS_ERROR = 2;
const STREAMING_AVAILABLE = 0;
const STREAMING_IN_USE = 1;

/**
 * The HAP connection surface `RTPStreamManagement` consumes while setting up endpoints. A real
 * controller connection is only an address plus a `closed` event, which is the whole reason a prepared
 * session's lifetime can be scoped to it.
 */
function hapConnection(): EventEmitter & { localAddress: string; getLocalAddress(): string } {
  const connection = new EventEmitter() as EventEmitter & { localAddress: string; getLocalAddress(): string };
  connection.localAddress = '192.0.2.20';
  connection.getLocalAddress = () => '192.0.2.20';
  return connection;
}

function streamManagements(accessory: PlatformAccessory): Service[] {
  return accessory.services.filter((service) => service.UUID === Service.CameraRTPStreamManagement.UUID);
}

function setupEndpointsWrite(sessionID: string): string {
  return encodeTlv(
    1,
    uuid.write(sessionID),
    3,
    encodeTlv(1, 0, 2, '192.0.2.10', 3, writeUInt16(50100), 4, writeUInt16(50101)),
    4,
    encodeTlv(1, SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80, 2, Buffer.alloc(16, 1), 3, Buffer.alloc(14, 2)),
    5,
    encodeTlv(1, SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80, 2, Buffer.alloc(16, 3), 3, Buffer.alloc(14, 4)),
  ).toString('base64');
}

/**
 * Writes `SetupEndpoints` the way a controller does and reads back the answer the accessory serves. A
 * refused preparation fails the write and leaves an `ERROR` answer for the next read, which is what a
 * controller observes, so both halves are reported.
 */
async function setupEndpoints(
  management: Service,
  connection: ReturnType<typeof hapConnection>,
  sessionID: string,
): Promise<{ status: number; videoPort?: number; refusedWrite?: true }> {
  const characteristic = management.getCharacteristic(Characteristic.SetupEndpoints);
  const refusedWrite = await characteristic.handleSetRequest(setupEndpointsWrite(sessionID), connection as never).then(
    () => false,
    () => true,
  );
  const answer = decodeTlv(
    Buffer.from((await characteristic.handleGetRequest(connection as never)) as string, 'base64'),
  );
  const address = answer[3] ? decodeTlv(answer[3]) : undefined;
  return {
    status: answer[2]![0]!,
    ...(address ? { videoPort: readUInt16(address[3]!) } : {}),
    ...(refusedWrite ? { refusedWrite: true as const } : {}),
  };
}

function streamingStatus(management: Service): number {
  const value = management.getCharacteristic(Characteristic.StreamingStatus).value as string;
  return decodeTlv(Buffer.from(value, 'base64'))[1]![0]!;
}

/**
 * The video codec configuration one stream management service advertises, decoded with the accessory
 * side's own TLV reader so the expectation is what a controller reads rather than what the plugin meant.
 * A HomeKit controller may select any profile, level, and resolution in it, so this is the complete set of
 * combinations live qualification has to honor.
 */
function advertisedVideo(value: string): {
  codec: number;
  profiles: number[];
  levels: number[];
  packetizationMode: number;
  resolutions: number[][];
} {
  const configuration = decodeTlvWithLists(decodeTlvWithLists(Buffer.from(value, 'base64'))[1] as Buffer);
  const parameters = decodeTlv(configuration[2] as Buffer);
  const attributes = configuration[3];
  return {
    codec: (configuration[1] as Buffer)[0]!,
    profiles: [...parameters[1]!],
    levels: [...parameters[2]!],
    packetizationMode: parameters[3]![0]!,
    resolutions: (Array.isArray(attributes) ? attributes : [attributes as Buffer]).map((entry) => {
      const resolution = decodeTlv(entry);
      return [readUInt16(resolution[1]!), readUInt16(resolution[2]!), resolution[3]![0]!];
    }),
  };
}

function jpeg(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(marker, 'utf8'), Buffer.from([0xff, 0xd9])]);
}

function retainedImages(entries: readonly (readonly [string, Buffer])[] = []) {
  const retained = new Map(entries);
  return {
    read: (serial: string) => retained.get(serial),
    write: vi.fn((serial: string, image: Buffer) => {
      retained.set(serial, image);
    }),
  } satisfies LastSuccessfulImages;
}

function pendingLiveSnapshot(): {
  snapshotLive: ReturnType<typeof vi.fn>;
  complete(image: Buffer): void;
} {
  let resolveLive: ((value: { jpeg: Buffer; width: number; height: number }) => void) | undefined;
  return {
    snapshotLive: vi.fn(
      () =>
        new Promise<{ jpeg: Buffer; width: number; height: number }>((resolve) => {
          resolveLive = resolve;
        }),
    ),
    complete(image: Buffer): void {
      resolveLive?.({ jpeg: image, width: 1280, height: 720 });
    },
  };
}

function snapshotEvidence(
  ...members: readonly ('snapshotStored' | 'snapshotLive')[]
): AdapterAttachmentContext['evidence'] {
  return new Map([
    ['camera.live.momentary-action', { id: 'camera.live.momentary-action', kind: 'momentary-action' as const }],
    ...members.map(
      (member) =>
        [
          `camera.${member}.momentary-action`,
          { id: `camera.${member}.momentary-action`, kind: 'momentary-action' as const },
        ] as const,
    ),
  ]);
}

/**
 * The admitted enabled observation a camera reports alongside its live media. Overrides express a
 * manifest that reports the row with different semantics, which must not be trusted as an enablement
 * observation.
 */
function enabledEvidence(
  evidence: AdapterAttachmentContext['evidence'],
  overrides: Partial<DeviceMemberEvidence> = {},
): AdapterAttachmentContext['evidence'] {
  return new Map([
    ...evidence,
    [
      'camera.enabled.read',
      { id: 'camera.enabled.read', kind: 'read' as const, type: 'bool' as const, writable: true, ...overrides },
    ],
  ]);
}

/** A camera whose enabled observation can be moved, counting every read the adapter performs. */
function observedCamera(initial: boolean | string | undefined, faulty = false) {
  const state = { value: initial, reads: 0 };
  return {
    state,
    camera: {
      get enabled(): unknown {
        state.reads += 1;
        if (faulty) {
          throw new Error('synthetic enabled observation fault');
        }
        return state.value;
      },
      live: vi.fn(),
      snapshotLive: vi.fn(async () => ({ jpeg: jpeg('synthetic disabled still'), width: 1280, height: 720 })),
    },
  };
}

/** Every camera operating mode service one accessory carries, whoever created it. */
function operatingModes(accessory: PlatformAccessory) {
  return accessory.services.filter((service) => service.UUID === Service.CameraOperatingMode.UUID);
}

/**
 * The presented disabled state, or nothing at all when the accessory publishes none. An accessory carrying
 * more than one operating mode service is a HAP invariant this plugin must not reach, so it is refused here
 * rather than answered: a caller comparing against a boolean would read it as a plain disagreement.
 */
function presentedDisabled(accessory: PlatformAccessory): boolean | undefined {
  const services = operatingModes(accessory);
  if (services.length > 1) {
    throw new Error('accessory carries more than one camera operating mode service');
  }
  const [service] = services;
  return service?.testCharacteristic(Characteristic.ManuallyDisabled)
    ? Boolean(service.getCharacteristic(Characteristic.ManuallyDisabled).value)
    : undefined;
}

/**
 * A camera surface that answers the SDK's out-of-band trust statement with its enablement member.
 *
 * `unreflectedMembers` reads a symbol-keyed statement that only the SDK's own binding attaches, and no
 * camera family currently reports one, so a proxy answering every symbol read is the only way to exercise a
 * member the SDK declines to stand behind. The test asserts the proxy really is reported as unreflected
 * rather than assuming the plugin was asked the question.
 */
function untrustedCamera(enabled: boolean) {
  const { state, camera } = observedCamera(enabled);
  return {
    state,
    camera: new Proxy(camera, {
      get(inner, property, receiver) {
        return typeof property === 'symbol' ? Object.freeze(['enabled']) : Reflect.get(inner, property, receiver);
      },
    }),
  };
}

function startRequest(sessionID: string, ssrc: number): StreamingRequest {
  return {
    sessionID,
    type: StreamRequestTypes.START,
    video: {
      codec: 0,
      profile: H264Profile.MAIN,
      level: H264Level.LEVEL3_1,
      packetizationMode: 0,
      width: 1280,
      height: 720,
      fps: 30,
      pt: 99,
      ssrc,
      max_bit_rate: 300,
      rtcp_interval: 0.5,
      mtu: 1200,
    },
  } as StreamingRequest;
}

describe('camera streaming bundle adapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the packaged disabled image without acquiring or serving a real one while a camera is off', async () => {
    const target = new Accessory(
      'Synthetic disabled snapshot camera',
      uuid.generate('synthetic-disabled-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const retained = jpeg('synthetic retained image');
    const images = retainedImages([[SNAPSHOT_SERIAL, retained]]);
    const snapshotStored = vi.fn();
    const { state, camera } = observedCamera(false);
    const diagnose = vi.fn();
    const observed = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => Object.assign(camera, { snapshotStored }) } as never,
      evidence: enabledEvidence(snapshotEvidence('snapshotStored', 'snapshotLive')),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_DISABLED_IMAGE);
    expect(snapshotStored).not.toHaveBeenCalled();
    expect(camera.snapshotLive).not.toHaveBeenCalled();
    expect(images.write).not.toHaveBeenCalled();
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-snapshot-unavailable'),
    ).toEqual([]);

    state.value = true;
    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);
  });

  it('fails closed without acquisition or retained disclosure when the disabled image is unusable', async () => {
    const target = new Accessory(
      'Synthetic missing disabled presentation camera',
      uuid.generate('synthetic-missing-disabled-presentation-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotStored = vi.fn();
    const { camera } = observedCamera(false);
    const images = retainedImages([[SNAPSHOT_SERIAL, jpeg('private retained image')]]);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => Object.assign(camera, { snapshotStored }) } as never,
      evidence: enabledEvidence(snapshotEvidence('snapshotStored', 'snapshotLive')),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images, () => Buffer.from('not a jpeg')),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).rejects.toThrow('disabled camera presentation is unavailable');
    expect(snapshotStored).not.toHaveBeenCalled();
    expect(camera.snapshotLive).not.toHaveBeenCalled();
    expect(images.write).not.toHaveBeenCalled();
  });

  it('never implies a disabled camera from a missing or malformed enablement observation', async () => {
    for (const [label, evidence, value] of [
      ['unevidenced', snapshotEvidence('snapshotStored'), false],
      ['malformed', enabledEvidence(snapshotEvidence('snapshotStored'), { type: 'string' }), 'off'],
    ] as const) {
      const target = new Accessory(
        `Synthetic ${label} snapshot camera`,
        uuid.generate(`synthetic-${label}-snapshot-camera`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const retained = jpeg(`synthetic ${label} retained image`);
      const { camera } = observedCamera(value);

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
        evidence,
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        snapshotMedia: new SnapshotAcquisition(retainedImages([[SNAPSHOT_SERIAL, retained]])),
        snapshotMode: 'Refresh',
        audioEnabled: false,
        diagnose: vi.fn(),
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await expect(callSnapshot(controller.delegate), label).resolves.toEqual(retained);
    }
  });

  it('presents typed offline only when no retained real image exists', async () => {
    const target = new Accessory(
      'Synthetic offline snapshot camera',
      uuid.generate('synthetic-offline-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotStored = vi.fn(async () => {
      throw new Error('no stored image');
    });
    const diagnose = vi.fn();
    const observed = vi.fn();
    const images = retainedImages();
    let availability: AvailabilityObservation | undefined;

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotStored, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotStored'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Cloud',
      audioEnabled: false,
      availability: () => availability,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);

    availability = {
      entity: { kind: 'device', sn: SNAPSHOT_SERIAL },
      availability: 'unavailable',
      source: { transport: 'smqtt', signal: 'state-info' },
      scope: 'device',
      receivedAt: 1,
    };
    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_OFFLINE_IMAGE);
    expect(observed).toHaveBeenCalledWith('camera-snapshot-unavailable');

    const retained = jpeg('synthetic retained offline fallback');
    images.write(SNAPSHOT_SERIAL, retained, 'live');
    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);
  });

  it('does not schedule a Refresh live acquisition while explicitly unavailable', async () => {
    const target = new Accessory(
      'Synthetic unavailable refresh camera',
      uuid.generate('synthetic-unavailable-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotLive = vi.fn();
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(retainedImages()),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      availability: () => ({
        entity: { kind: 'device', sn: SNAPSHOT_SERIAL },
        availability: 'unavailable',
        source: { transport: 'smqtt', signal: 'state-info' },
        scope: 'device',
        receivedAt: 1,
      }),
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_OFFLINE_IMAGE);
    expect(snapshotLive).not.toHaveBeenCalled();
  });

  it('ignores malformed or misattributed availability observations', async () => {
    for (const availability of [
      { entity: { kind: 'device', sn: 'ANOTHER0000000001' }, availability: 'unavailable' },
      { entity: { kind: 'device', sn: SNAPSHOT_SERIAL }, availability: 'offline' },
      { entity: { kind: 'device', sn: SNAPSHOT_SERIAL }, availability: 'unavailable', receivedAt: Number.NaN },
    ]) {
      const target = new Accessory(
        'Synthetic uncertain snapshot camera',
        uuid.generate(`synthetic-uncertain-snapshot-camera-${JSON.stringify(availability)}`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn() }) } as never,
        evidence: snapshotEvidence(),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        snapshotMedia: new SnapshotAcquisition(retainedImages()),
        snapshotMode: 'Cloud',
        audioEnabled: false,
        availability: () => availability as never,
        diagnose: vi.fn(),
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    }
  });

  it('serves a Refresh snapshot from the last successful image and rate-limits live refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const target = new Accessory(
      'Synthetic refresh snapshot camera',
      uuid.generate('synthetic-refresh-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const retained = jpeg('synthetic retained image');
    const refreshed = jpeg('synthetic refreshed image');
    const images = retainedImages([[SNAPSHOT_SERIAL, retained]]);
    const { snapshotLive, complete } = pendingLiveSnapshot();
    const snapshotStored = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotStored, snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotStored', 'snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);
    expect(snapshotStored).not.toHaveBeenCalled();
    expect(snapshotLive).toHaveBeenCalledOnce();

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);
    expect(snapshotLive).toHaveBeenCalledOnce();

    complete(refreshed);
    await vi.waitFor(() => expect(images.write).toHaveBeenCalledWith(SNAPSHOT_SERIAL, refreshed, 'live'));
    await expect(callSnapshot(controller.delegate)).resolves.toEqual(refreshed);
    expect(snapshotLive).toHaveBeenCalledOnce();

    vi.setSystemTime(Date.now() + 600_000);
    await expect(callSnapshot(controller.delegate)).resolves.toEqual(refreshed);
    expect(snapshotLive).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 600_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snapshotLive).toHaveBeenCalledTimes(2);
  });

  it('acquires a stored-only Refresh image when no last successful image exists', async () => {
    const target = new Accessory(
      'Synthetic empty refresh camera',
      uuid.generate('synthetic-empty-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const stored = jpeg('synthetic stored image');
    const images = retainedImages();
    const snapshotStored = vi.fn(async () => stored);
    const { snapshotLive } = pendingLiveSnapshot();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotStored, snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotStored', 'snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(stored);
    expect(images.write).toHaveBeenCalledWith(SNAPSHOT_SERIAL, stored, 'stored-only');

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(stored);
    expect(snapshotStored).toHaveBeenCalledOnce();
  });

  it('presents unavailable when Refresh acquisitions return invalid image bytes', async () => {
    const target = new Accessory(
      'Synthetic invalid refresh snapshot camera',
      uuid.generate('synthetic-invalid-refresh-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const images = retainedImages();
    const invalid = Buffer.from('synthetic non-image payload', 'utf8');
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({
          snapshotStored: vi.fn(async () => invalid),
          snapshotLive: vi.fn(async () => ({ jpeg: invalid, width: 1280, height: 720 })),
          live: vi.fn(),
        }),
      } as never,
      evidence: snapshotEvidence('snapshotStored', 'snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    await vi.waitFor(() => expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ active: true })));
    expect(images.write).not.toHaveBeenCalled();
  });

  it('serves the packaged unavailable placeholder when no admitted acquisition can answer', async () => {
    const target = new Accessory(
      'Synthetic unavailable refresh camera',
      uuid.generate('synthetic-unavailable-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const { snapshotLive } = pendingLiveSnapshot();
    const images = retainedImages();
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(images.write).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-unavailable',
      capability: 'camera',
      member: 'snapshot',
      active: true,
      reason: 'no-retained-image',
    });
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-capability-unavailable',
      capability: 'camera',
      member: 'snapshotStored',
      active: false,
      reason: 'recovered',
    });
  });

  it('fails a snapshot request when this package carries no usable placeholder', async () => {
    for (const [label, packaged] of [
      ['absent', () => undefined],
      ['malformed', () => Buffer.from('not a jpeg at all')],
    ] as const) {
      const target = new Accessory(
        `Synthetic ${label} placeholder camera`,
        uuid.generate(`synthetic-${label}-placeholder-camera`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const diagnose = vi.fn();

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn() }) } as never,
        evidence: snapshotEvidence(),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        snapshotMedia: new SnapshotAcquisition(retainedImages(), packaged),
        snapshotMode: 'Refresh',
        audioEnabled: false,
        diagnose,
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await expect(callSnapshot(controller.delegate), label).rejects.toThrow('no camera snapshot image is available');
      expect(
        diagnose.mock.calls
          .map(([condition]) => condition)
          .filter(({ code }) => code === 'camera-snapshot-unavailable'),
        label,
      ).toEqual([
        {
          code: 'camera-snapshot-unavailable',
          capability: 'camera',
          member: 'snapshot',
          active: true,
          reason: 'no-acquisition',
        },
      ]);
    }
  });

  it('reports a Refresh camera that has no admitted snapshot acquisition at all', () => {
    const target = new Accessory(
      'Synthetic unacquirable refresh camera',
      uuid.generate('synthetic-unacquirable-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(retainedImages()),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    for (const member of ['snapshotStored', 'snapshotLive']) {
      expect(diagnose).toHaveBeenCalledWith({
        code: 'camera-snapshot-capability-unavailable',
        capability: 'camera',
        member,
        active: true,
        reason: 'missing-evidence',
      });
    }
  });

  it('retains a successful Live snapshot as the last successful image', async () => {
    const target = new Accessory(
      'Synthetic retained live snapshot camera',
      uuid.generate('synthetic-retained-live-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const live = jpeg('synthetic live image');
    const images = retainedImages();

    CAMERA_STREAMING_ADAPTER.attach({
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({
          snapshotLive: vi.fn(async () => ({ jpeg: live, width: 1280, height: 720 })),
          live: vi.fn(),
        }),
      } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(live);
    expect(images.write).toHaveBeenCalledWith(SNAPSHOT_SERIAL, live, 'live');
  });

  it('does not retain a live snapshot that completes after its entity was discarded', async () => {
    const images = retainedImages();
    const acquisition = new SnapshotAcquisition(images);
    const { snapshotLive, complete } = pendingLiveSnapshot();
    const capture = acquisition.captureFromWarmLive({ identity: {}, serial: SNAPSHOT_SERIAL }, { snapshotLive });
    await vi.waitFor(() => expect(snapshotLive).toHaveBeenCalledOnce());

    acquisition.discard(SNAPSHOT_SERIAL);
    complete(jpeg('late snapshot'));
    await capture;

    expect(images.write).not.toHaveBeenCalled();
  });

  it('serves Cloud snapshots only from passive SDK storage', async () => {
    const target = new Accessory(
      'Synthetic cloud snapshot camera',
      uuid.generate('synthetic-cloud-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const stored = jpeg('synthetic stored image');
    const snapshotStored = vi.fn(async () => stored);
    const snapshotLive = vi.fn();
    const live = vi.fn();
    const prepare = vi.fn();
    const images = retainedImages();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotStored, snapshotLive, live }) } as never,
      evidence: snapshotEvidence('snapshotStored'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Cloud',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toBe(stored);
    expect(snapshotStored).toHaveBeenCalledOnce();
    expect(snapshotLive).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(images.write).toHaveBeenCalledWith(SNAPSHOT_SERIAL, stored, 'stored-only');
  });

  it('coalesces only concurrent Live snapshots and otherwise acquires a fresh image', async () => {
    const target = new Accessory(
      'Synthetic live snapshot camera',
      uuid.generate('synthetic-live-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const first = jpeg('synthetic first live image');
    const second = jpeg('synthetic second live image');
    let resolveFirst!: (value: { jpeg: Buffer; width: number; height: number }) => void;
    const snapshotLive = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ jpeg: Buffer; width: number; height: number }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ jpeg: second, width: 640, height: 360 });
    const snapshotStored = vi.fn();
    const snapshotMedia = new SnapshotAcquisition();

    const context = {
      device: { camera: () => ({ snapshotStored, snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia,
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext;
    CAMERA_STREAMING_ADAPTER.attach(context);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    const firstRequest = callSnapshot(controller.delegate);
    await vi.waitFor(() => expect(snapshotLive).toHaveBeenCalledOnce());
    CAMERA_STREAMING_ADAPTER.attach(context);
    const secondRequest = callSnapshot(controller.delegate);
    expect(snapshotLive).toHaveBeenCalledOnce();
    resolveFirst({ jpeg: first, width: 1280, height: 720 });
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([first, first]);
    await expect(callSnapshot(controller.delegate)).resolves.toBe(second);

    expect(snapshotLive).toHaveBeenCalledTimes(2);
    expect(snapshotStored).not.toHaveBeenCalled();
  });

  it('serves the placeholder for a selected snapshot policy without its exact SDK evidence', async () => {
    const target = new Accessory(
      'Synthetic unevidenced snapshot camera',
      uuid.generate('synthetic-unevidenced-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotStored = vi.fn(async () => Buffer.from('synthetic stored jpeg'));
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ snapshotStored, live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(),
      snapshotMode: 'Cloud',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotStored).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-capability-unavailable',
      capability: 'camera',
      member: 'snapshotStored',
      active: true,
      reason: 'missing-evidence',
    });
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-unavailable',
      capability: 'camera',
      member: 'snapshot',
      active: true,
      reason: 'stored-unavailable',
    });
  });

  it('diagnoses a selected snapshot policy without media adaptation', () => {
    const target = new Accessory(
      'Synthetic unadapted snapshot camera',
      uuid.generate('synthetic-unadapted-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ snapshotStored: vi.fn(), live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotStored'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMode: 'Cloud',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-capability-unavailable',
      capability: 'camera',
      member: 'snapshotStored',
      active: true,
      reason: 'adapter-missing',
    });
  });

  it('does not coalesce a new Live request after complete evidence withdrawal', async () => {
    const target = new Accessory(
      'Synthetic withdrawn live snapshot camera',
      uuid.generate('synthetic-withdrawn-live-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const admitted = jpeg('synthetic admitted image');
    let resolveSnapshot!: (value: { jpeg: Buffer; width: number; height: number }) => void;
    const snapshotLive = vi.fn(
      () =>
        new Promise<{ jpeg: Buffer; width: number; height: number }>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const common = {
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(),
      snapshotMode: 'Live' as const,
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    };
    CAMERA_STREAMING_ADAPTER.attach({
      ...common,
      device: { camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const admittedRequest = callSnapshot(controller.delegate);
    await vi.waitFor(() => expect(snapshotLive).toHaveBeenCalledOnce());

    CAMERA_STREAMING_ADAPTER.attach({
      ...common,
      device: { camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
    } satisfies AdapterAttachmentContext);

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotLive).toHaveBeenCalledOnce();
    resolveSnapshot({ jpeg: admitted, width: 1280, height: 720 });
    await expect(admittedRequest).resolves.toEqual(admitted);
  });

  it('serves the placeholder for a failed Live acquisition without falling back to stored imagery', async () => {
    const target = new Accessory(
      'Synthetic failed live snapshot camera',
      uuid.generate('synthetic-failed-live-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const acquired = jpeg('synthetic recovered live image');
    const snapshotStored = vi.fn(async () => Buffer.from('synthetic stored jpeg'));
    const snapshotLive = vi
      .fn<() => Promise<{ jpeg: Buffer; width: number; height: number }>>()
      .mockRejectedValueOnce(new Error('synthetic live snapshot failure'))
      .mockResolvedValueOnce({ jpeg: acquired, width: 1280, height: 720 });
    const diagnose = vi.fn();
    const observed = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ snapshotStored, snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(),
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(snapshotStored).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-unavailable',
      capability: 'camera',
      member: 'snapshot',
      active: true,
      reason: 'live-failed',
    });
    expect(observed).not.toHaveBeenCalledWith('camera-snapshot-unavailable');

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(acquired);
    expect(observed).toHaveBeenCalledWith('camera-snapshot-unavailable');
    expect(snapshotStored).not.toHaveBeenCalled();
  });

  it('attributes an unanswered snapshot to the acquisition its selected mode requires', async () => {
    for (const [mode, reason] of [
      ['Cloud', 'stored-unavailable'],
      ['Live', 'live-unavailable'],
    ] as const) {
      const target = new Accessory(
        `Synthetic ${mode} unacquirable camera`,
        uuid.generate(`synthetic-${mode}-unacquirable-camera`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const diagnose = vi.fn();

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn() }) } as never,
        evidence: snapshotEvidence(),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        snapshotMedia: new SnapshotAcquisition(retainedImages()),
        snapshotMode: mode,
        audioEnabled: false,
        diagnose,
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await expect(callSnapshot(controller.delegate), mode).resolves.toEqual(PACKAGED_PLACEHOLDER);
      expect(
        diagnose.mock.calls
          .map(([condition]) => condition)
          .filter(({ code }) => code === 'camera-snapshot-unavailable'),
        mode,
      ).toEqual([
        { code: 'camera-snapshot-unavailable', capability: 'camera', member: 'snapshot', active: true, reason },
      ]);
    }
  });

  it('attributes a refused snapshot request to the snapshot adaptation it never had', async () => {
    const target = new Accessory(
      'Synthetic unadapted refresh camera',
      uuid.generate('synthetic-unadapted-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({ snapshotStored: vi.fn(), snapshotLive: vi.fn(), live: vi.fn() }),
      } as never,
      evidence: snapshotEvidence('snapshotStored', 'snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).rejects.toThrow('camera snapshot adaptation is unavailable');
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-snapshot-unavailable'),
    ).toEqual([
      {
        code: 'camera-snapshot-unavailable',
        capability: 'camera',
        member: 'snapshot',
        active: true,
        reason: 'adapter-missing',
      },
    ]);
  });

  it('attributes an unanswered snapshot to the typed reason the SDK acquisition reports', async () => {
    const cases = [
      ...(['not-observed', 'pending', 'download-failed', 'invalid-image'] as const).map((reason) => ({
        mode: 'Cloud' as const,
        member: 'snapshotStored' as const,
        rejection: new StoredSnapshotUnavailableError(reason, 'synthetic stored refusal'),
        expected: `stored-${reason}`,
      })),
      ...(['no-keyframe', 'source-failed', 'undecodable-burst', 'decoder-unavailable'] as const).map((reason) => ({
        mode: 'Live' as const,
        member: 'snapshotLive' as const,
        rejection: new LiveSnapshotUnavailableError(reason, 'synthetic live refusal'),
        expected: `live-${reason}`,
      })),
    ];

    for (const { mode, member, rejection, expected } of cases) {
      const target = new Accessory(
        `Synthetic ${expected} camera`,
        uuid.generate(`synthetic-${expected}-camera`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const acquisition = vi.fn().mockRejectedValue(rejection);
      const diagnose = vi.fn();

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => ({ [member]: acquisition, live: vi.fn() }) } as never,
        evidence: snapshotEvidence(member),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        snapshotMedia: new SnapshotAcquisition(retainedImages()),
        snapshotMode: mode,
        audioEnabled: false,
        diagnose,
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await expect(callSnapshot(controller.delegate), expected).resolves.toEqual(PACKAGED_PLACEHOLDER);
      expect(acquisition, expected).toHaveBeenCalledOnce();
      expect(
        diagnose.mock.calls
          .map(([condition]) => condition)
          .filter(({ code }) => code === 'camera-snapshot-unavailable'),
        expected,
      ).toEqual([
        {
          code: 'camera-snapshot-unavailable',
          capability: 'camera',
          member: 'snapshot',
          active: true,
          reason: expected,
        },
      ]);
    }
  });

  it('attributes an unanswered Refresh snapshot to the stored acquisition that failed', async () => {
    const target = new Accessory(
      'Synthetic failed stored refresh camera',
      uuid.generate('synthetic-failed-stored-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotStored = vi.fn<() => Promise<Buffer>>().mockRejectedValue(new Error('synthetic stored failure'));
    const images = retainedImages();
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotStored, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotStored'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotStored).toHaveBeenCalledOnce();
    expect(images.write).not.toHaveBeenCalled();
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-snapshot-unavailable'),
    ).toEqual([
      {
        code: 'camera-snapshot-unavailable',
        capability: 'camera',
        member: 'snapshot',
        active: true,
        reason: 'stored-failed',
      },
    ]);
  });

  it('attributes an intermittent Refresh camera to the live refresh that failed while nothing is retained', async () => {
    const target = new Accessory(
      'Synthetic intermittent refresh camera',
      uuid.generate('synthetic-intermittent-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const snapshotLive = vi
      .fn<() => Promise<{ jpeg: Buffer; width: number; height: number }>>()
      .mockRejectedValue(new Error('synthetic live refresh failure'));
    const images = retainedImages();
    const diagnose = vi.fn();
    const reported = () =>
      diagnose.mock.calls
        .map(([condition]) => condition)
        .filter(({ code }) => code === 'camera-snapshot-unavailable')
        .map(({ reason }) => reason);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotLive).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reported()).toContain('live-failed'));
    expect(reported().at(-1)).toBe('live-failed');

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(reported().at(-1)).toBe('live-failed');
    expect(images.write).not.toHaveBeenCalled();
  });

  it('keeps a retained image authoritative when a background live refresh fails', async () => {
    const target = new Accessory(
      'Synthetic retained refresh camera',
      uuid.generate('synthetic-retained-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const retained = jpeg('synthetic retained refresh image');
    const snapshotLive = vi
      .fn<() => Promise<{ jpeg: Buffer; width: number; height: number }>>()
      .mockRejectedValue(new Error('synthetic live refresh failure'));
    const images = retainedImages([[SNAPSHOT_SERIAL, retained]]);
    const diagnose = vi.fn();
    const observed = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(images),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);
    await vi.waitFor(() => expect(snapshotLive).toHaveBeenCalledOnce());
    expect(observed).toHaveBeenCalledWith('camera-snapshot-unavailable');
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-snapshot-unavailable'),
    ).toEqual([]);
  });

  it('advertises exactly the profile, level, and resolution matrix a live run may select', () => {
    const target = new Accessory(
      'Synthetic advertised matrix camera',
      uuid.generate('synthetic-camera-advertised'),
    ) as unknown as PlatformAccessory;

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: true,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    for (const management of streamManagements(target)) {
      const advertised = management.getCharacteristic(Characteristic.SupportedVideoStreamConfiguration).value as string;

      expect(advertisedVideo(advertised)).toEqual({
        codec: 0,
        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        packetizationMode: 0,
        resolutions: [
          [320, 180, 15],
          [640, 360, 30],
          [1280, 720, 30],
          [1920, 1080, 30],
        ],
      });
    }
  });

  it('drives negotiated prepare, start, reconfigure, and stop through the media seam and traces the identity-free video selection a controller starts and reconfigures', async () => {
    const target = new Accessory(
      'Synthetic camera',
      uuid.generate('synthetic-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const reconfigure = vi.fn();
    const stop = vi.fn();
    const prepared: PreparedLiveMedia = { videoPort: 41000, audioPort: 41001, start, reconfigure, stop };
    const prepare = vi.fn(async () => prepared);
    const camera = { live: vi.fn() } as unknown as CameraActions;
    const trace = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => camera } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: true,
      diagnose: vi.fn(),
      observed: vi.fn(),
      trace,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    expect(target.services.filter((service) => service.UUID === Service.Microphone.UUID)).toHaveLength(0);
    expect(target.services.filter((service) => service.UUID === Service.Speaker.UUID)).toHaveLength(0);
    const request = prepareRequest();
    const response = await callPrepare(controller.delegate, request);

    expect(response.video.port).toBe(41000);
    expect(response.audio?.port).toBe(41001);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        addressVersion: 'ipv4',
        targetAddress: '192.0.2.10',
        video: expect.objectContaining({ port: 50100 }),
        audio: expect.objectContaining({ port: 50101 }),
      }),
    );

    await callStream(controller.delegate, {
      sessionID: request.sessionID,
      type: StreamRequestTypes.START,
      video: {
        codec: 0,
        profile: H264Profile.MAIN,
        level: H264Level.LEVEL3_1,
        packetizationMode: 0,
        width: 1280,
        height: 720,
        fps: 30,
        pt: 99,
        ssrc: response.video.ssrc,
        max_bit_rate: 300,
        rtcp_interval: 0.5,
        mtu: 1200,
      },
      audio: {
        codec: AudioStreamingCodecType.AAC_ELD,
        channel: 1,
        bit_rate: 0,
        sample_rate: AudioStreamingSamplerate.KHZ_16,
        packet_time: 20,
        pt: 110,
        ssrc: response.audio!.ssrc,
        max_bit_rate: 24,
        rtcp_interval: 0.5,
        comfort_pt: 13,
        comfortNoiseEnabled: false,
      },
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ live: expect.any(Function) }),
      expect.objectContaining({
        video: expect.objectContaining({ width: 1280, height: 720, fps: 30, maxBitRate: 300 }),
        audio: expect.objectContaining({ codec: 'AAC-eld', sampleRate: 16, channels: 1 }),
      }),
    );
    expect(trace).toHaveBeenCalledWith({
      event: 'live-video-selected',
      operation: 'start',
      profile: 'main',
      level: '3.1',
      width: 1280,
      height: 720,
      fps: 30,
    });

    await callStream(controller.delegate, {
      sessionID: request.sessionID,
      type: StreamRequestTypes.RECONFIGURE,
      video: { width: 640, height: 360, fps: 15, max_bit_rate: 150, rtcp_interval: 0.5 },
    });
    expect(reconfigure).toHaveBeenCalledWith(expect.objectContaining({ width: 640, height: 360, fps: 15 }));
    expect(trace).toHaveBeenLastCalledWith({
      event: 'live-video-selected',
      operation: 'reconfigure',
      profile: 'main',
      level: '3.1',
      width: 640,
      height: 360,
      fps: 15,
    });

    await callStream(controller.delegate, { sessionID: request.sessionID, type: StreamRequestTypes.STOP });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('serves a snapshot during an active live session without disturbing its media', async () => {
    const target = new Accessory(
      'Synthetic overlapping camera',
      uuid.generate('synthetic-overlapping-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const reconfigure = vi.fn();
    const stop = vi.fn();
    const prepare = vi.fn(async () => ({ videoPort: 41000, start, reconfigure, stop }) satisfies PreparedLiveMedia);
    const still = jpeg('synthetic overlapping still');
    const snapshotLive = vi
      .fn<() => Promise<{ jpeg: Buffer; width: number; height: number }>>()
      .mockResolvedValueOnce({ jpeg: still, width: 1280, height: 720 })
      .mockRejectedValueOnce(new Error('synthetic still acquisition failed'));
    const live = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      snapshotMedia: new SnapshotAcquisition(retainedImages()),
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const connection = hapConnection();
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0006';

    await expect(setupEndpoints(management, connection, sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    await callStream(controller.delegate, {
      sessionID,
      type: StreamRequestTypes.START,
      video: {
        codec: 0,
        profile: H264Profile.MAIN,
        level: H264Level.LEVEL3_1,
        packetizationMode: 0,
        width: 1280,
        height: 720,
        fps: 30,
        pt: 99,
        ssrc: 1,
        max_bit_rate: 300,
        rtcp_interval: 0.5,
        mtu: 1200,
      },
    } as StreamingRequest);

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(still);

    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(reconfigure).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(streamingStatus(management)).toBe(STREAMING_IN_USE);

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(still);
    expect(stop).not.toHaveBeenCalled();
    expect(streamingStatus(management)).toBe(STREAMING_IN_USE);

    await callStream(controller.delegate, { sessionID, type: StreamRequestTypes.STOP });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('serves a retained image during an active live session without waiting for a live acquisition', async () => {
    const target = new Accessory(
      'Synthetic warm retained camera',
      uuid.generate('synthetic-warm-retained-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const stop = vi.fn();
    const prepare = vi.fn(
      async () => ({ videoPort: 41000, start, reconfigure: vi.fn(), stop }) satisfies PreparedLiveMedia,
    );
    const retained = jpeg('synthetic retained still');
    const { snapshotLive } = pendingLiveSnapshot();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      snapshotMedia: new SnapshotAcquisition(retainedImages([[SNAPSHOT_SERIAL, retained]])),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a000b';

    await expect(setupEndpoints(management, hapConnection(), sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    await callStream(controller.delegate, startRequest(sessionID, 1));

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(retained);

    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(streamingStatus(management)).toBe(STREAMING_IN_USE);
  });

  it('keeps two concurrent negotiated sessions independent on one camera', async () => {
    const target = new Accessory(
      'Synthetic concurrent camera',
      uuid.generate('synthetic-concurrent-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const sessions = [41000, 41002].map((videoPort) => ({
      videoPort,
      start: vi.fn(async () => undefined),
      reconfigure: vi.fn(),
      stop: vi.fn(),
    }));
    const prepare = vi.fn(async () => sessions[prepare.mock.calls.length - 1] as PreparedLiveMedia);
    const live = vi.fn();

    const attachment = CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    const first = await callPrepare(controller.delegate, prepareRequest('first-session'));
    const second = await callPrepare(controller.delegate, prepareRequest('second-session'));
    expect([first.video.port, second.video.port]).toEqual([41000, 41002]);
    expect(first.video.ssrc).not.toBe(second.video.ssrc);

    for (const sessionID of ['first-session', 'second-session']) {
      await callStream(controller.delegate, {
        sessionID,
        type: StreamRequestTypes.START,
        video: {
          codec: 0,
          profile: H264Profile.MAIN,
          level: H264Level.LEVEL3_1,
          packetizationMode: 0,
          width: 1280,
          height: 720,
          fps: 30,
          pt: 99,
          ssrc: sessionID === 'first-session' ? first.video.ssrc : second.video.ssrc,
          max_bit_rate: 300,
          rtcp_interval: 0.5,
          mtu: 1200,
        },
      } as StreamingRequest);
    }
    expect(sessions[0].start).toHaveBeenCalledOnce();
    expect(sessions[1].start).toHaveBeenCalledOnce();
    expect(live).not.toHaveBeenCalled();

    await callStream(controller.delegate, { sessionID: 'first-session', type: StreamRequestTypes.STOP });
    expect(sessions[0].stop).toHaveBeenCalledOnce();
    expect(sessions[1].stop).not.toHaveBeenCalled();

    await callStream(controller.delegate, {
      sessionID: 'second-session',
      type: StreamRequestTypes.RECONFIGURE,
      video: { width: 640, height: 360, fps: 15, max_bit_rate: 150, rtcp_interval: 0.5 },
    });
    expect(sessions[1].reconfigure).toHaveBeenCalledWith(
      expect.objectContaining({ width: 640, ssrc: second.video.ssrc }),
    );

    attachment?.detach?.();
    expect(sessions[1].stop).toHaveBeenCalledOnce();
    expect(sessions[0].stop).toHaveBeenCalledOnce();
  });

  it('closes a prepared session that completes after adapter detachment', async () => {
    const target = new Accessory(
      'Synthetic pending camera',
      uuid.generate('synthetic-pending-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const stop = vi.fn();
    const prepared: PreparedLiveMedia = {
      videoPort: 41000,
      start: vi.fn(async () => undefined),
      reconfigure: vi.fn(),
      stop,
    };
    let resolvePrepare!: (value: PreparedLiveMedia) => void;
    const prepare = vi.fn(
      () =>
        new Promise<PreparedLiveMedia>((resolve) => {
          resolvePrepare = resolve;
        }),
    );
    const attachment = CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    });
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    const pending = callPrepare(controller.delegate, prepareRequest('pending-session'));
    attachment?.detach?.();
    resolvePrepare(prepared);

    await expect(pending).rejects.toThrow('cancelled');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('stops camera media without removing its controller during process shutdown', () => {
    const target = new Accessory(
      'Synthetic shutdown camera',
      uuid.generate('synthetic-shutdown-camera'),
    ) as unknown as PlatformAccessory;
    const removeController = vi.spyOn(target, 'removeController');
    const attachment = CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    });

    attachment?.detach?.('shutdown');

    expect(removeController).not.toHaveBeenCalled();
  });

  it('holds a prepared session that never starts until its HAP connection closes', async () => {
    const target = new Accessory(
      'Synthetic idle camera',
      uuid.generate('synthetic-idle-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const sessions = [41000, 41002].map((videoPort) => ({
      videoPort,
      start: vi.fn(async () => undefined),
      reconfigure: vi.fn(),
      stop: vi.fn(),
    }));
    const prepare = vi.fn(async () => sessions[prepare.mock.calls.length - 1] as PreparedLiveMedia);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    expect(configureController).toHaveBeenCalledOnce();
    const [first, second] = streamManagements(target);
    const connection = hapConnection();
    vi.useFakeTimers();

    await expect(setupEndpoints(first!, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0001')).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    expect(streamingStatus(first!)).toBe(STREAMING_IN_USE);

    await expect(setupEndpoints(first!, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0002')).resolves.toEqual({
      status: SETUP_ENDPOINTS_BUSY,
    });
    await expect(setupEndpoints(second!, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0003')).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41002,
    });
    expect(prepare).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(sessions.map((session) => session.stop.mock.calls.length)).toEqual([0, 0]);
    expect(streamingStatus(first!)).toBe(STREAMING_IN_USE);
    expect(streamingStatus(second!)).toBe(STREAMING_IN_USE);

    connection.emit('closed');
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions[0]!.stop).toHaveBeenCalledOnce();
    expect(sessions[1]!.stop).toHaveBeenCalledOnce();
    expect(sessions[0]!.start).not.toHaveBeenCalled();
    expect(streamingStatus(first!)).toBe(STREAMING_AVAILABLE);
    expect(streamingStatus(second!)).toBe(STREAMING_AVAILABLE);
    await expect(
      first!.getCharacteristic(Characteristic.SetupEndpoints).handleGetRequest(connection as never),
    ).resolves.toBe(encodeTlv(2, SETUP_ENDPOINTS_ERROR).toString('base64'));
  });

  it('forgets a session HomeKit closed after a video failure instead of restarting its media', async () => {
    const target = new Accessory(
      'Synthetic force-stopped camera',
      uuid.generate('synthetic-force-stopped-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const stop = vi.fn();
    let failVideo: (() => void) | undefined;
    const prepare = vi.fn(async (transport: { onVideoFailure?(): void }) => {
      failVideo = () => transport.onVideoFailure?.();
      return { videoPort: 41000, start, reconfigure: vi.fn(), stop } satisfies PreparedLiveMedia;
    });

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const connection = hapConnection();
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0004';

    await expect(setupEndpoints(management, connection, sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });

    failVideo?.();
    expect(streamingStatus(management)).toBe(STREAMING_AVAILABLE);

    await expect(
      callStream(controller.delegate, {
        sessionID,
        type: StreamRequestTypes.START,
        video: {
          codec: 0,
          profile: H264Profile.MAIN,
          level: H264Level.LEVEL3_1,
          packetizationMode: 0,
          width: 1280,
          height: 720,
          fps: 30,
          pt: 99,
          ssrc: 1,
          max_bit_rate: 300,
          rtcp_interval: 0.5,
          mtu: 1200,
        },
      } as StreamingRequest),
    ).rejects.toThrow('live media session was not prepared');
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();

    await expect(
      callStream(controller.delegate, { sessionID, type: StreamRequestTypes.STOP }),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();

    await expect(setupEndpoints(management, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0005')).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
  });

  it('latches one live-session failure reason and clears it when a later session streams', async () => {
    const target = new Accessory(
      'Synthetic reported camera',
      uuid.generate('synthetic-reported-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const reporters: Array<(outcome: LiveSessionOutcome) => void> = [];
    const releases: Array<() => void> = [];
    const prepare = vi.fn(async (transport: LiveMediaTransport) => {
      reporters.push((outcome) => transport.onSessionOutcome?.(outcome));
      releases.push(() => transport.onSessionReleased?.());
      return {
        videoPort: 41000 + reporters.length,
        start: vi.fn(async () => undefined),
        reconfigure: vi.fn(),
        stop: vi.fn(),
      } satisfies PreparedLiveMedia;
    });
    const diagnose = vi.fn();
    const observed = vi.fn();
    const trace = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose,
      observed,
      trace,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await callPrepare(controller.delegate, prepareRequest('failed-session'));
    reporters[0]!({
      outcome: 'failed',
      reason: 'no-video-within-backstop',
      stage: 'first-source-keyframe',
    });
    const liveConditions = (): unknown[] =>
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-live-session-failed');

    expect(liveConditions()).toEqual([
      {
        code: 'camera-live-session-failed',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'no-video-within-backstop',
      },
    ]);
    expect(observed).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith({
      event: 'live-session-failed',
      outcome: 'failed',
      reason: 'no-video-within-backstop',
      stage: 'first-source-keyframe',
    });
    releases[0]!();
    expect(trace).toHaveBeenCalledWith({ event: 'live-session-released' });

    await callPrepare(controller.delegate, prepareRequest('streaming-session'));
    reporters[1]!({ outcome: 'streaming' });

    expect(observed).toHaveBeenCalledExactlyOnceWith('camera-live-session-failed');
    expect(liveConditions()).toHaveLength(1);
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain(SNAPSHOT_SERIAL);
  });

  it('retains at most one fallback image after a HomeKit live session starts producing output', async () => {
    const target = new Accessory(
      'Synthetic warm capture camera',
      uuid.generate('synthetic-warm-capture-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    let report!: (outcome: LiveSessionOutcome) => void;
    const prepared = {
      videoPort: 41000,
      start: vi.fn(async () => undefined),
      reconfigure: vi.fn(),
      stop: vi.fn(),
    } satisfies PreparedLiveMedia;
    const prepare = vi.fn(async (transport: LiveMediaTransport) => {
      report = (outcome) => transport.onSessionOutcome?.(outcome);
      return prepared;
    });
    const captureFromWarmLive = vi.fn(async () => undefined);
    const camera = { live: vi.fn(), snapshotLive: vi.fn() };

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      snapshotMedia: { acquire: vi.fn(), captureFromWarmLive },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const delegate = (
      configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      }
    ).delegate;
    const request = prepareRequest('warm-capture-session');

    await callPrepare(delegate, request);
    report({ outcome: 'streaming' });
    expect(captureFromWarmLive).not.toHaveBeenCalled();

    await callStream(delegate, startRequest(request.sessionID, 1));
    report({ outcome: 'streaming' });
    report({ outcome: 'streaming' });

    expect(captureFromWarmLive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ serial: SNAPSHOT_SERIAL }),
      expect.objectContaining({ snapshotLive: expect.any(Function) }),
    );
    expect(prepared.stop).not.toHaveBeenCalled();
  });

  it('refuses a live session while the admitted enabled observation says the camera is disabled', async () => {
    const target = new Accessory(
      'Synthetic disabled camera',
      uuid.generate('synthetic-disabled-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const prepare = vi.fn(
      async () =>
        ({
          videoPort: 41000,
          start: vi.fn(async () => undefined),
          reconfigure: vi.fn(),
          stop: vi.fn(),
        }) satisfies PreparedLiveMedia,
    );
    const diagnose = vi.fn();
    const observed = vi.fn();
    const { state, camera } = observedCamera(false);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence('snapshotLive')),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      snapshotMedia: new SnapshotAcquisition(retainedImages()),
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const connection = hapConnection();

    await expect(setupEndpoints(management, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0007')).resolves.toEqual({
      status: SETUP_ENDPOINTS_ERROR,
      refusedWrite: true,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(streamingStatus(management)).toBe(STREAMING_AVAILABLE);
    expect(management.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    expect(diagnose.mock.calls.map(([condition]) => condition)).toEqual(
      expect.arrayContaining([
        {
          code: 'camera-live-session-refused',
          capability: 'camera',
          member: 'live',
          active: true,
          reason: 'disabled',
        },
      ]),
    );
    expect(observed).not.toHaveBeenCalledWith('camera-live-session-refused');

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_DISABLED_IMAGE);

    state.value = true;
    await expect(setupEndpoints(management, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0007')).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    expect(observed).toHaveBeenCalledWith('camera-live-session-refused');
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain(SNAPSHOT_SERIAL);
  });

  it('presents a camera the admitted observation reports as disabled to HomeKit as disabled', async () => {
    for (const enabled of [true, false]) {
      const target = new Accessory(
        `Synthetic presented ${enabled ? 'enabled' : 'disabled'} camera`,
        uuid.generate(`synthetic-presented-${enabled}-camera-stream`),
      ) as unknown as PlatformAccessory;
      const { camera } = observedCamera(enabled);

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
        evidence: enabledEvidence(snapshotEvidence()),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        audioEnabled: false,
        diagnose: vi.fn(),
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);

      expect(operatingModes(target), String(enabled)).toHaveLength(1);
      expect(presentedDisabled(target), String(enabled)).toBe(!enabled);
      const [service] = operatingModes(target);
      expect(service!.getCharacteristic(Characteristic.HomeKitCameraActive).value, String(enabled)).toBe(
        Characteristic.HomeKitCameraActive.ON,
      );
      expect(service!.getCharacteristic(Characteristic.EventSnapshotsActive).value, String(enabled)).toBe(
        Characteristic.EventSnapshotsActive.ENABLE,
      );
    }
  });

  it('follows the enablement change event rather than a timer', async () => {
    const target = new Accessory(
      'Synthetic observed enablement camera',
      uuid.generate('synthetic-observed-enablement-camera-stream'),
    ) as unknown as PlatformAccessory;
    const { state, camera } = observedCamera(true);
    const trace = vi.fn();

    const attached = CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      trace,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    vi.useFakeTimers();

    expect(presentedDisabled(target)).toBe(false);

    state.value = false;
    expect(attached!.event!({ eventName: 'cameraEnabledChanged', deviceSn: SNAPSHOT_SERIAL } as never)).toEqual({
      event: 'camera-enabled-changed',
      observation: 'valid',
    });

    expect(presentedDisabled(target)).toBe(true);
    expect(trace).not.toHaveBeenCalled();

    state.value = true;
    expect(attached!.event!({ eventName: 'cameraEnabled', deviceSn: SNAPSHOT_SERIAL, enabled: true } as never)).toEqual(
      {
        event: 'camera-enabled-changed',
        observation: 'valid',
      },
    );
    expect(presentedDisabled(target)).toBe(false);

    state.value = false;
    expect(attached!.event!({ eventName: 'motion', deviceSn: SNAPSHOT_SERIAL } as never)).toBeUndefined();
    expect(presentedDisabled(target)).toBe(false);
    vi.useRealTimers();
  });

  it('ends an active session on the enablement change event instead of waiting for the next read', async () => {
    const target = new Accessory(
      'Synthetic event terminated camera',
      uuid.generate('synthetic-event-terminated-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const stop = vi.fn();
    const prepare = vi.fn(
      async () => ({ videoPort: 41000, start, reconfigure: vi.fn(), stop }) satisfies PreparedLiveMedia,
    );
    const { state, camera } = observedCamera(true);
    const diagnose = vi.fn();

    const attached = CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a000b';

    await expect(setupEndpoints(management, hapConnection(), sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    await callStream(controller.delegate, startRequest(sessionID, 1));
    expect(streamingStatus(management)).toBe(STREAMING_IN_USE);

    vi.useFakeTimers();
    state.value = false;
    attached!.event!({ eventName: 'cameraEnabledChanged', deviceSn: SNAPSHOT_SERIAL } as never);

    expect(stop).toHaveBeenCalledOnce();
    expect(streamingStatus(management)).toBe(STREAMING_AVAILABLE);
    expect(presentedDisabled(target)).toBe(true);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-live-session-refused'),
    ).toEqual([
      {
        code: 'camera-live-session-refused',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'disabled-mid-session',
      },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('answers a HomeKit read of the presented state from the observation as it reads then', async () => {
    const target = new Accessory(
      'Synthetic read presented camera',
      uuid.generate('synthetic-read-presented-camera-stream'),
    ) as unknown as PlatformAccessory;
    const { state, camera } = observedCamera(true);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const characteristic = operatingModes(target)[0]!.getCharacteristic(Characteristic.ManuallyDisabled);

    state.value = false;
    await expect(characteristic.handleGetRequest()).resolves.toBe(true);
    state.value = true;
    await expect(characteristic.handleGetRequest()).resolves.toBe(false);
    state.value = undefined;
    await expect(characteristic.handleGetRequest()).resolves.toBe(false);
  });

  it('republishes the presented state from the supervision read that ends the session', async () => {
    const target = new Accessory(
      'Synthetic supervised presented camera',
      uuid.generate('synthetic-supervised-presented-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const prepare = vi.fn(
      async () =>
        ({
          videoPort: 41000,
          start: vi.fn(async () => undefined),
          reconfigure: vi.fn(),
          stop: vi.fn(),
        }) satisfies PreparedLiveMedia,
    );
    const { state, camera } = observedCamera(true);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a000d';
    vi.useFakeTimers();

    await expect(setupEndpoints(streamManagements(target)[0]!, hapConnection(), sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    await callStream(controller.delegate, startRequest(sessionID, 1));
    expect(presentedDisabled(target)).toBe(false);

    state.value = false;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(presentedDisabled(target)).toBe(true);
    vi.useRealTimers();
  });

  it('presents no operating mode state without an exactly evidenced boolean enablement observation', async () => {
    const cases = [
      { label: 'unevidenced', evidence: snapshotEvidence(), camera: observedCamera(false) },
      {
        label: 'malformed',
        evidence: enabledEvidence(snapshotEvidence(), { type: 'string' }),
        camera: observedCamera('off'),
      },
      { label: 'faulty', evidence: enabledEvidence(snapshotEvidence()), camera: observedCamera(undefined, true) },
      { label: 'unobserved', evidence: enabledEvidence(snapshotEvidence()), camera: observedCamera(undefined) },
    ];

    for (const { label, evidence, camera } of cases) {
      const target = new Accessory(
        `Synthetic unpresented ${label} camera`,
        uuid.generate(`synthetic-unpresented-${label}-camera-stream`),
      ) as unknown as PlatformAccessory;
      const attached = CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => camera.camera } as never,
        evidence,
        accessory: target,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        audioEnabled: false,
        diagnose: vi.fn(),
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);

      expect(operatingModes(target), label).toEqual([]);
      expect(
        attached!.event!({ eventName: 'cameraEnabledChanged', deviceSn: SNAPSHOT_SERIAL } as never),
        label,
      ).toEqual({ event: 'camera-enabled-changed', observation: 'missing' });
      expect(operatingModes(target), label).toEqual([]);
    }
  });

  it('keeps the presented state a read could not answer, rather than withdrawing a camera on a failed read', async () => {
    const target = new Accessory(
      'Synthetic faulting presented camera',
      uuid.generate('synthetic-faulting-presented-camera-stream'),
    ) as unknown as PlatformAccessory;
    const state = { value: false as boolean | undefined, faults: false };
    const camera = {
      get enabled(): unknown {
        if (state.faults) {
          throw new Error('synthetic enabled observation fault');
        }
        return state.value;
      },
      live: vi.fn(),
    };

    const attached = CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const characteristic = operatingModes(target)[0]!.getCharacteristic(Characteristic.ManuallyDisabled);
    expect(presentedDisabled(target)).toBe(true);

    state.faults = true;
    expect(attached!.event!({ eventName: 'cameraEnabledChanged', deviceSn: SNAPSHOT_SERIAL } as never)).toEqual({
      event: 'camera-enabled-changed',
      observation: 'missing',
    });

    expect(presentedDisabled(target)).toBe(true);
    await expect(characteristic.handleGetRequest()).resolves.toBe(true);
  });

  it('withdraws a published disabled state when a reconciliation leaves no observation to act on', async () => {
    const target = new Accessory(
      'Synthetic withdrawn presentation camera',
      uuid.generate('synthetic-withdrawn-presentation-camera-stream'),
    ) as unknown as PlatformAccessory;
    const { camera } = observedCamera(false);
    const context = {
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext;

    CAMERA_STREAMING_ADAPTER.attach(context);
    expect(presentedDisabled(target)).toBe(true);

    CAMERA_STREAMING_ADAPTER.attach({ ...context, evidence: snapshotEvidence() });

    expect(operatingModes(target)).toEqual([]);
  });

  it('presents on an operating mode service the accessory restored from a run that configured recording', () => {
    const target = new Accessory(
      'Synthetic restored operating mode camera',
      uuid.generate('synthetic-restored-operating-mode-camera-stream'),
    ) as unknown as PlatformAccessory;
    const { camera } = observedCamera(false);
    target.addService(Service.CameraOperatingMode, '', '');

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    expect(operatingModes(target)).toHaveLength(1);
    expect(presentedDisabled(target)).toBe(true);
  });

  it('declines an enablement observation the SDK names as unreflected', async () => {
    const target = new Accessory(
      'Synthetic untrusted enablement camera',
      uuid.generate('synthetic-untrusted-enablement-camera-stream'),
    ) as unknown as PlatformAccessory;
    const prepare = vi.fn(
      async () =>
        ({
          videoPort: 41000,
          start: vi.fn(async () => undefined),
          reconfigure: vi.fn(),
          stop: vi.fn(),
        }) satisfies PreparedLiveMedia,
    );
    const diagnose = vi.fn();
    const { camera } = untrustedCamera(false);
    expect(unreflectedMembers(camera)).toContain('enabled');

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);

    expect(operatingModes(target)).toEqual([]);
    await expect(
      setupEndpoints(streamManagements(target)[0]!, hapConnection(), '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a000c'),
    ).resolves.toEqual({ status: SETUP_ENDPOINTS_SUCCESS, videoPort: 41000 });
    expect(prepare).toHaveBeenCalledOnce();
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-live-session-refused'),
    ).toEqual([]);
  });

  it('reports a disabled camera that answered a session with no video as switched off, not as a transport failure', async () => {
    const cases = [
      { label: 'disabled', enabled: false, code: 'camera-live-session-refused', reason: 'disabled-no-video' },
      { label: 'enabled', enabled: true, code: 'camera-live-session-failed', reason: 'source-audio-only' },
    ];

    for (const { label, enabled, code, reason } of cases) {
      const target = new Accessory(
        `Synthetic silent ${label} camera`,
        uuid.generate(`synthetic-silent-${label}-camera-stream`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const reporters: Array<(outcome: LiveSessionOutcome) => void> = [];
      const prepare = vi.fn(async (transport: LiveMediaTransport) => {
        reporters.push((outcome) => transport.onSessionOutcome?.(outcome));
        return {
          videoPort: 41000,
          start: vi.fn(async () => undefined),
          reconfigure: vi.fn(),
          stop: vi.fn(),
        } satisfies PreparedLiveMedia;
      });
      const diagnose = vi.fn();
      const trace = vi.fn();
      const { state, camera } = observedCamera(true);

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
        evidence: enabledEvidence(snapshotEvidence()),
        accessory: target,
        hap: HAP,
        liveMedia: { prepare },
        audioEnabled: false,
        diagnose,
        observed: vi.fn(),
        trace,
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const controller = configureController.mock.calls[0][0] as CameraController & {
        delegate: CameraStreamingDelegate;
      };

      await callPrepare(controller.delegate, prepareRequest(`silent-${label}-session`));
      state.value = enabled;
      reporters[0]!({ outcome: 'failed', reason: 'source-audio-only', stage: 'first-source-keyframe' });

      expect(
        diagnose.mock.calls
          .map(([condition]) => condition)
          .filter(({ code: reported }) => String(reported).startsWith('camera-live-session-')),
        label,
      ).toEqual([{ code, capability: 'camera', member: 'live', active: true, reason }]);
      expect(trace, label).toHaveBeenCalledWith({
        event: 'live-session-failed',
        outcome: 'failed',
        reason: 'source-audio-only',
        stage: 'first-source-keyframe',
      });
    }
  });

  it('gates a live session only on an exactly evidenced boolean enablement observation', async () => {
    const cases = [
      { label: 'unevidenced', evidence: snapshotEvidence(), camera: observedCamera(false) },
      {
        label: 'malformed',
        evidence: enabledEvidence(snapshotEvidence(), { type: 'string' }),
        camera: observedCamera('off'),
      },
      { label: 'faulty', evidence: enabledEvidence(snapshotEvidence()), camera: observedCamera(undefined, true) },
      { label: 'unobserved', evidence: enabledEvidence(snapshotEvidence()), camera: observedCamera(undefined) },
    ];

    for (const { label, evidence, camera } of cases) {
      const target = new Accessory(
        `Synthetic ${label} camera`,
        uuid.generate(`synthetic-${label}-camera-stream`),
      ) as unknown as PlatformAccessory;
      const configureController = vi.spyOn(target, 'configureController');
      const prepare = vi.fn(
        async () =>
          ({
            videoPort: 41000,
            start: vi.fn(async () => undefined),
            reconfigure: vi.fn(),
            stop: vi.fn(),
          }) satisfies PreparedLiveMedia,
      );
      const diagnose = vi.fn();

      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => camera.camera } as never,
        evidence,
        accessory: target,
        hap: HAP,
        liveMedia: { prepare },
        audioEnabled: false,
        diagnose,
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
      const management = streamManagements(target)[0]!;

      await expect(
        setupEndpoints(management, hapConnection(), '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0008'),
        label,
      ).resolves.toEqual({ status: SETUP_ENDPOINTS_SUCCESS, videoPort: 41000 });
      expect(prepare, label).toHaveBeenCalledOnce();
      expect(
        diagnose.mock.calls
          .map(([condition]) => condition)
          .filter(({ code }) => code === 'camera-live-session-refused'),
        label,
      ).toEqual([]);
    }
  });

  it('refuses a start for a camera observed disabled after its session was prepared', async () => {
    const target = new Accessory(
      'Synthetic late disabled camera',
      uuid.generate('synthetic-late-disabled-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const stop = vi.fn();
    const prepare = vi.fn(
      async () => ({ videoPort: 41000, start, reconfigure: vi.fn(), stop }) satisfies PreparedLiveMedia,
    );
    const { state, camera } = observedCamera(true);

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0009';

    await expect(setupEndpoints(streamManagements(target)[0]!, hapConnection(), sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });

    state.value = false;
    await expect(callStream(controller.delegate, startRequest(sessionID, 1))).rejects.toThrow('disabled');
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('terminates an active session and stops its media when the camera is later observed disabled', async () => {
    const target = new Accessory(
      'Synthetic supervised camera',
      uuid.generate('synthetic-supervised-camera-stream'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const start = vi.fn(async () => undefined);
    const stop = vi.fn();
    const prepare = vi.fn(
      async () => ({ videoPort: 41000, start, reconfigure: vi.fn(), stop }) satisfies PreparedLiveMedia,
    );
    const { state, camera } = observedCamera(true);
    const diagnose = vi.fn();
    const observed = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => camera } as never,
      evidence: enabledEvidence(snapshotEvidence()),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: false,
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };
    const management = streamManagements(target)[0]!;
    const connection = hapConnection();
    const sessionID = '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a000a';
    vi.useFakeTimers();

    const idleReads = state.reads;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.reads).toBe(idleReads);

    await expect(setupEndpoints(management, connection, sessionID)).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    await callStream(controller.delegate, startRequest(sessionID, 1));
    expect(streamingStatus(management)).toBe(STREAMING_IN_USE);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).not.toHaveBeenCalled();
    expect(state.reads).toBeGreaterThan(idleReads);

    state.value = false;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(stop).toHaveBeenCalledOnce();
    expect(streamingStatus(management)).toBe(STREAMING_AVAILABLE);
    expect(management.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.ACTIVE);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-live-session-refused'),
    ).toEqual([
      {
        code: 'camera-live-session-refused',
        capability: 'camera',
        member: 'live',
        active: true,
        reason: 'disabled-mid-session',
      },
    ]);

    const terminatedReads = state.reads;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.reads).toBe(terminatedReads);
    expect(stop).toHaveBeenCalledOnce();
  });
});

/** Little-endian scalars, the width HomeKit's recording configuration TLVs use for each field. */
function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function int16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16LE(value, 0);
  return buffer;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

interface SelectedRecording {
  prebufferLength?: number;
  fragmentLength?: number;
  profile?: number;
  level?: number;
  bitRate?: number;
  iFrameInterval?: number;
  resolution?: [number, number, number];
  audioCodec?: number;
  audioChannels?: number;
  samplerate?: number;
  audioBitrate?: number;
}

/**
 * Writes `SelectedCameraRecordingConfiguration` exactly the way a HomeKit controller does, so the
 * configuration the recording delegate receives is the one HAP itself parsed off the wire.
 */
function selectRecordingConfiguration(
  controller: CameraController,
  connection: ReturnType<typeof hapConnection>,
  {
    prebufferLength = 4_000,
    fragmentLength = 4_000,
    profile = H264Profile.HIGH,
    level = H264Level.LEVEL4_0,
    bitRate = 2_000,
    iFrameInterval = 4_000,
    resolution = [1920, 1080, 30],
    audioCodec = AudioRecordingCodecType.AAC_LC,
    audioChannels = 1,
    samplerate = AudioRecordingSamplerate.KHZ_32,
    audioBitrate = 32,
  }: SelectedRecording = {},
): Promise<unknown> {
  const value = encodeTlv(
    1,
    encodeTlv(
      1,
      int32(prebufferLength),
      2,
      Buffer.concat([int32(EventTriggerOption.MOTION), int32(0)]),
      3,
      encodeTlv(1, MediaContainerType.FRAGMENTED_MP4, 2, encodeTlv(1, int32(fragmentLength))),
    ),
    2,
    encodeTlv(
      1,
      VideoCodecType.H264,
      2,
      encodeTlv(1, profile, 2, level, 3, int32(bitRate), 4, int32(iFrameInterval)),
      3,
      encodeTlv(1, int16(resolution[0]), 2, int16(resolution[1]), 3, resolution[2]),
    ),
    3,
    encodeTlv(
      1,
      audioCodec,
      2,
      encodeTlv(1, audioChannels, 2, AudioBitrate.VARIABLE, 3, samplerate, 4, uint32(audioBitrate)),
    ),
  ).toString('base64');
  return controller
    .recordingManagement!.recordingManagementService.getCharacteristic(
      Characteristic.SelectedCameraRecordingConfiguration,
    )
    .handleSetRequest(value, connection as never);
}

/** One adapted recording whose units, completion, and failure this specification delivers. */
function syntheticRecording() {
  const pending: RecordedFragment[] = [];
  let waiting:
    { resolve: (result: IteratorResult<RecordedFragment>) => void; reject: (e: unknown) => void } | undefined;
  let ended = false;
  const stop = vi.fn(() => {
    ended = true;
    waiting?.resolve({ done: true, value: undefined });
    waiting = undefined;
  });
  return {
    stop,
    push(fragment: RecordedFragment): void {
      if (waiting) {
        const resolve = waiting.resolve;
        waiting = undefined;
        resolve({ done: false, value: fragment });
        return;
      }
      pending.push(fragment);
    },
    fail(error: unknown): void {
      waiting?.reject(error);
      waiting = undefined;
    },
    recording: {
      stop,
      [Symbol.asyncIterator](): AsyncIterator<RecordedFragment> {
        return {
          next: () =>
            new Promise<IteratorResult<RecordedFragment>>((resolve, reject) => {
              const ready = pending.shift();
              if (ready) {
                resolve({ done: false, value: ready });
                return;
              }
              if (ended) {
                resolve({ done: true, value: undefined });
                return;
              }
              waiting = { resolve, reject };
            }),
          return: async () => {
            stop();
            return { done: true, value: undefined };
          },
        };
      },
    } satisfies AdaptedRecording,
  };
}

/** A recording media seam that records every negotiated contract it was asked to adapt. */
function recordingMedia() {
  const negotiations: NegotiatedRecording[] = [];
  const sources: RecordingMediaSource[] = [];
  const outcomes: ((outcome: RecordingOutcome) => void)[] = [];
  const sessions: ReturnType<typeof syntheticRecording>[] = [];
  return {
    negotiations,
    sources,
    sessions,
    report(outcome: RecordingOutcome): void {
      outcomes.at(-1)?.(outcome);
    },
    adapter: {
      record(source, negotiated, lifecycle): AdaptedRecording {
        sources.push(source);
        negotiations.push(negotiated);
        outcomes.push((outcome) => lifecycle?.onOutcome?.(outcome));
        const session = syntheticRecording();
        sessions.push(session);
        return session.recording;
      },
    } satisfies RecordingMediaAdapter,
  };
}

/**
 * The evidence a camera needs before HomeKit Secure Video may be configured for it: the fragment recording
 * itself, and an admitted event to trigger one.
 */
function recordingEvidence(
  evidence: AdapterAttachmentContext['evidence'] = new Map(),
  { trigger = true }: { trigger?: boolean } = {},
): AdapterAttachmentContext['evidence'] {
  return new Map([
    ...evidence,
    [
      'camera.recordFragments.momentary-action',
      { id: 'camera.recordFragments.momentary-action', kind: 'momentary-action' as const },
    ],
    ...(trigger ? ([['motion.motion.event', { id: 'motion.motion.event', kind: 'event' as const }]] as const) : []),
  ]);
}

/** Exact SDK action evidence that admits controller return audio. */
function talkbackEvidence(
  evidence: AdapterAttachmentContext['evidence'] = recordingEvidence(),
): AdapterAttachmentContext['evidence'] {
  return new Map([
    ...evidence,
    ['camera.talkback.momentary-action', { id: 'camera.talkback.momentary-action', kind: 'momentary-action' as const }],
  ]);
}

function attachRecordingCamera(
  name: string,
  overrides: Partial<AdapterAttachmentContext> = {},
): {
  controller: CameraController;
  delegate: CameraRecordingDelegate;
  accessory: PlatformAccessory;
  diagnose: ReturnType<typeof vi.fn>;
  observed: ReturnType<typeof vi.fn>;
} {
  const accessory = new Accessory(name, uuid.generate(name)) as unknown as PlatformAccessory;
  const configureController = vi.spyOn(accessory, 'configureController');
  const diagnose = vi.fn();
  const observed = vi.fn();
  CAMERA_STREAMING_ADAPTER.attach({
    device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), recordFragments: vi.fn() }) } as never,
    evidence: recordingEvidence(),
    accessory,
    hap: HAP,
    liveMedia: { prepare: vi.fn() },
    recordingMedia: recordingMedia().adapter,
    snapshotMedia: new SnapshotAcquisition(retainedImages([])),
    snapshotMode: 'Refresh',
    diagnose,
    observed,
    persist: vi.fn(),
    ...overrides,
  } satisfies AdapterAttachmentContext);
  const controller = configureController.mock.calls[0][0] as CameraController;
  return { controller, delegate: controller.recordingManagement!.delegate, accessory, diagnose, observed };
}

/** A live media seam that records the media source each negotiated session was started against. */
function liveMedia() {
  const started: LiveMediaSource[] = [];
  const prepare = vi.fn(
    async () =>
      ({
        videoPort: 41100,
        audioPort: 41101,
        start: async (source: LiveMediaSource) => {
          started.push(source);
        },
        reconfigure: vi.fn(),
        stop: vi.fn(),
      }) satisfies PreparedLiveMedia,
  );
  return { started, adapter: { prepare } satisfies LiveMediaAdapter };
}

/** Negotiates and starts one live session, the way a controller opening live view does. */
async function startLiveSession(delegate: CameraStreamingDelegate, sessionID = 'synthetic-prebuffer-session') {
  const response = await callPrepare(delegate, prepareRequest(sessionID));
  await callStream(delegate, startRequest(sessionID, response.video.ssrc));
}

/** Negotiate and start the 16 kHz AAC-ELD audio selection return audio is defined against. */
async function startAudioLiveSession(delegate: CameraStreamingDelegate, sessionID = 'synthetic-talkback-session') {
  const response = await callPrepare(delegate, prepareRequest(sessionID));
  await callStream(delegate, {
    ...startRequest(sessionID, response.video.ssrc),
    audio: {
      codec: AudioStreamingCodecType.AAC_ELD,
      channel: 1,
      bit_rate: 0,
      sample_rate: AudioStreamingSamplerate.KHZ_16,
      packet_time: 30,
      pt: 110,
      ssrc: response.audio!.ssrc,
      max_bit_rate: 24,
      rtcp_interval: 0.5,
      comfort_pt: 13,
      comfortNoiseEnabled: false,
    },
  } as StreamingRequest);
}

/** Consumes a recording stream the way HAP's own recording transport does. */
function consumeRecordingStream(delegate: CameraRecordingDelegate, streamId: number, signal?: AbortSignal) {
  const packets: RecordingPacket[] = [];
  let failure: unknown;
  const generator = delegate.handleRecordingStreamRequest(streamId, signal);
  const iteration = (async () => {
    for await (const packet of generator) {
      packets.push(packet);
      if (packet.isLast) {
        break;
      }
    }
  })().catch((error: unknown) => {
    failure = error;
  });
  return { packets, iteration, generator, failed: () => failure !== undefined, failure: () => failure };
}

describe('camera recording bundle adapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advertises the fragmented MP4 container, prebuffer, and motion trigger a recording may select', () => {
    const { controller, accessory } = attachRecordingCamera('Synthetic recording camera advertisement');
    expect(accessory.services.map((service) => service.UUID)).toEqual(
      expect.arrayContaining([
        Service.CameraRecordingManagement.UUID,
        Service.CameraOperatingMode.UUID,
        Service.DataStreamTransportManagement.UUID,
      ]),
    );
    const advertised = decodeTlv(
      Buffer.from(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.SupportedCameraRecordingConfiguration,
        ).value as string,
        'base64',
      ),
    );
    expect(advertised[1].readInt32LE(0)).toBe(4_000);
    expect(advertised[2].readInt32LE(0)).toBe(EventTriggerOption.MOTION);
    const container = decodeTlv(advertised[3]);
    expect(container[1][0]).toBe(MediaContainerType.FRAGMENTED_MP4);
    expect(decodeTlv(container[2])[1].readInt32LE(0)).toBe(4_000);
  });

  it("presents the disabled state on the recording controller's own operating mode service", () => {
    const { state, camera } = observedCamera(false);
    const { controller, accessory } = attachRecordingCamera('Synthetic recorded disabled camera', {
      device: { sn: SNAPSHOT_SERIAL, camera: () => Object.assign(camera, { recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(enabledEvidence(new Map())),
    });

    expect(operatingModes(accessory)).toEqual([controller.recordingManagement!.operatingModeService]);
    expect(presentedDisabled(accessory)).toBe(true);
    expect(state.value).toBe(false);
  });

  it('withdraws a stale operating mode service before the recording controller attaches its own', () => {
    const accessory = new Accessory(
      'Synthetic recovered recording camera',
      uuid.generate('synthetic-recovered-recording-camera'),
    ) as unknown as PlatformAccessory;
    const { camera } = observedCamera(true);
    accessory.addService(Service.CameraOperatingMode, accessory.displayName, 'camera.operating-mode');
    const configureController = vi.spyOn(accessory, 'configureController');

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => Object.assign(camera, { recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(enabledEvidence(new Map())),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: recordingMedia().adapter,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;

    expect(operatingModes(accessory)).toEqual([controller.recordingManagement!.operatingModeService]);
    expect(presentedDisabled(accessory)).toBe(false);
  });

  it('admits one 16 kHz return-audio source only from exact talkback evidence and a bound SDK action', async () => {
    const streaming = liveMedia();
    const talkback = vi.fn(async () => ({}) as never);
    const { controller, accessory } = attachRecordingCamera('Synthetic talkback camera', {
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), talkback, recordFragments: vi.fn() }) } as never,
      evidence: talkbackEvidence(),
      liveMedia: streaming.adapter,
    });

    await startAudioLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate);
    expect(streaming.started[0].talkback).toEqual(expect.any(Function));
    await streaming.started[0].talkback!();
    expect(talkback).toHaveBeenCalledExactlyOnceWith({ preBufferSeconds: 4 });

    for (const management of streamManagements(accessory)) {
      const advertised = decodeTlv(
        Buffer.from(
          management.getCharacteristic(Characteristic.SupportedAudioStreamConfiguration).value as string,
          'base64',
        ),
      );
      const codec = decodeTlv(advertised[1]);
      const parameters = decodeTlv(codec[2]);
      expect([...parameters[3]]).toEqual([1]);
    }
  });

  it('does not infer talkback from an SDK action without its exact evidence', async () => {
    const streaming = liveMedia();
    const talkback = vi.fn(async () => ({}) as never);
    const { controller, diagnose } = attachRecordingCamera('Synthetic unevidenced talkback camera', {
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), talkback, recordFragments: vi.fn() }) } as never,
      liveMedia: streaming.adapter,
    });

    await startAudioLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate);
    expect(streaming.started[0].talkback).toBeUndefined();
    expect(talkback).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-talkback-capability-unavailable',
      capability: 'camera',
      member: 'talkback',
      active: false,
      reason: 'recovered',
    });
  });

  it('reports talkback evidence whose SDK action is unavailable', () => {
    const { diagnose } = attachRecordingCamera('Synthetic unavailable talkback camera', {
      evidence: talkbackEvidence(),
    });

    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-talkback-capability-unavailable',
      capability: 'camera',
      member: 'talkback',
      active: true,
      reason: 'missing',
    });
  });

  it('does not admit talkback when camera audio is disabled', async () => {
    const streaming = liveMedia();
    const talkback = vi.fn(async () => ({}) as never);
    const { controller } = attachRecordingCamera('Synthetic muted talkback camera', {
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), talkback, recordFragments: vi.fn() }) } as never,
      evidence: talkbackEvidence(),
      liveMedia: streaming.adapter,
      audioEnabled: false,
    });

    await startLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate, 'synthetic-muted-talkback');
    expect(streaming.started[0].talkback).toBeUndefined();
  });

  it('opens battery or solar talkback without a pre-event window', async () => {
    const streaming = liveMedia();
    const talkback = vi.fn(async () => ({}) as never);
    const { controller } = attachRecordingCamera('Synthetic battery talkback camera', {
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), talkback, recordFragments: vi.fn() }) } as never,
      evidence: talkbackEvidence(
        recordingEvidence(
          new Map([
            [
              'battery.level.read',
              { id: 'battery.level.read', kind: 'read' as const, type: 'number' as const, writable: false },
            ],
          ]),
        ),
      ),
      liveMedia: streaming.adapter,
    });

    await startAudioLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate);
    await streaming.started[0].talkback!();
    expect(talkback).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('latches a talkback failure independently and clears it when later return audio starts', async () => {
    let transport: LiveMediaTransport | undefined;
    const { controller, diagnose, observed } = attachRecordingCamera('Synthetic failed talkback camera', {
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({ live: vi.fn(), talkback: vi.fn(async () => ({}) as never), recordFragments: vi.fn() }),
      } as never,
      evidence: talkbackEvidence(),
      liveMedia: {
        prepare: vi.fn(async (preparedTransport) => {
          transport = preparedTransport;
          return { videoPort: 41000, audioPort: 41001, start: vi.fn(), reconfigure: vi.fn(), stop: vi.fn() };
        }),
      },
    });
    await callPrepare((controller as { delegate: CameraStreamingDelegate }).delegate, prepareRequest());

    transport!.onTalkbackOutcome?.({ outcome: 'failed', reason: 'device-audio-failed' });
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-talkback-failed',
      capability: 'camera',
      member: 'talkback',
      active: true,
      reason: 'device-audio-failed',
    });

    transport!.onTalkbackOutcome?.({ outcome: 'talking' });
    expect(observed).toHaveBeenCalledWith('camera-talkback-failed');
  });

  it('rebuilds the camera controller when reconciliation changes its audio or talkback advertisement', () => {
    const accessory = new Accessory(
      'Synthetic reconciled talkback camera',
      uuid.generate('synthetic-reconciled-talkback'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const removeController = vi.spyOn(accessory, 'removeController');
    const observed = vi.fn();
    const base = {
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: recordingMedia().adapter,
      diagnose: vi.fn(),
      observed,
      persist: vi.fn(),
    } satisfies Partial<AdapterAttachmentContext>;
    const attach = (talkback: boolean, audioEnabled = true): void => {
      CAMERA_STREAMING_ADAPTER.attach({
        ...base,
        audioEnabled,
        device: {
          sn: SNAPSHOT_SERIAL,
          camera: () => ({ live: vi.fn(), recordFragments: vi.fn(), ...(talkback ? { talkback: vi.fn() } : {}) }),
        } as never,
        evidence: talkback ? talkbackEvidence() : recordingEvidence(),
      } as AdapterAttachmentContext);
    };

    attach(false, true);
    const withAudio = configureController.mock.calls[0][0] as CameraController;
    attach(false, false);
    const withoutAudio = configureController.mock.calls[1][0] as CameraController;
    attach(true, true);
    const withTalkback = configureController.mock.calls[2][0] as CameraController;
    attach(false, true);

    expect(configureController).toHaveBeenCalledTimes(4);
    expect(removeController).toHaveBeenNthCalledWith(1, withAudio);
    expect(removeController).toHaveBeenNthCalledWith(2, withoutAudio);
    expect(removeController).toHaveBeenNthCalledWith(3, withTalkback);
    expect(observed).toHaveBeenCalledWith('camera-talkback-failed');
  });

  it('links the motion sensor that triggers a recording to its recording management service', () => {
    const { controller, accessory } = attachRecordingCamera('Synthetic recording trigger camera');
    const motionSensors = accessory.services.filter((service) => service.UUID === Service.MotionSensor.UUID);
    expect(motionSensors).toHaveLength(1);
    expect(controller.recordingManagement!.recordingManagementService.linkedServices).toContain(motionSensors[0]);
    expect(controller.recordingManagement!.sensorServices).toContain(motionSensors[0]);
    expect(Boolean(motionSensors[0].getCharacteristic(Characteristic.StatusActive).value)).toBe(true);
    const advertised = decodeTlv(
      Buffer.from(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.SupportedCameraRecordingConfiguration,
        ).value as string,
        'base64',
      ),
    );
    expect(advertised[2].readInt32LE(0)).toBe(EventTriggerOption.MOTION);
  });

  it('shares one motion service with the detection adapter whichever of them attaches first', () => {
    const { accessory } = attachRecordingCamera('Synthetic shared motion camera');
    MOTION_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL } as never,
      evidence: recordingEvidence(),
      accessory,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    expect(accessory.services.filter((service) => service.UUID === Service.MotionSensor.UUID)).toHaveLength(1);
  });

  it('omits HomeKit Secure Video for a camera with no detection event to trigger a recording', () => {
    const accessory = new Accessory(
      'Synthetic untriggerable recording camera',
      uuid.generate('synthetic-untriggerable-recording-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const diagnose = vi.fn();
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(new Map(), { trigger: false }),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: recordingMedia().adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;
    expect(controller.recordingManagement).toBeUndefined();
    expect(accessory.services.map((service) => service.UUID)).not.toContain(Service.MotionSensor.UUID);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-recording-unavailable'),
    ).toEqual([
      {
        code: 'camera-recording-unavailable',
        capability: 'camera',
        member: 'recordFragments',
        active: true,
        reason: 'missing-trigger',
      },
    ]);
  });

  it('omits HomeKit Secure Video for a camera with no evidenced fragment recording', () => {
    const accessory = new Accessory(
      'Synthetic camera without recording',
      uuid.generate('synthetic-camera-without-recording'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const diagnose = vi.fn();
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn() }) } as never,
      evidence: new Map(),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: recordingMedia().adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      diagnose,
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;
    expect(controller.recordingManagement).toBeUndefined();
    expect(accessory.services.map((service) => service.UUID)).not.toContain(Service.CameraRecordingManagement.UUID);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-recording-unavailable'),
    ).toEqual([
      {
        code: 'camera-recording-unavailable',
        capability: 'camera',
        member: 'recordFragments',
        active: true,
        reason: 'missing-evidence',
      },
    ]);
  });

  it('adapts a recording to exactly the configuration a controller selected', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic negotiated recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection, {
      profile: H264Profile.MAIN,
      level: H264Level.LEVEL3_1,
      bitRate: 800,
      iFrameInterval: 4_000,
      fragmentLength: 4_000,
      resolution: [1280, 720, 15],
    });
    controller.recordingManagement!.recordingManagementService.updateCharacteristic(
      Characteristic.RecordingAudioActive,
      true,
    );

    const stream = consumeRecordingStream(delegate, 7);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations).toEqual([
      {
        width: 1280,
        height: 720,
        fps: 15,
        maxBitRate: 800,
        profile: 'main',
        level: '3.1',
        iFrameIntervalMs: 4_000,
        fragmentLengthMs: 4_000,
        prebufferLengthMs: 4_000,
        audio: { codec: 'AAC-lc', channels: 1, sampleRate: 32, maxBitRate: 32 },
      },
    ]);

    media.sessions[0].push({ data: Buffer.from('init'), last: false });
    media.sessions[0].push({ data: Buffer.from('fragment'), last: false });
    media.sessions[0].push({ data: Buffer.from('final'), last: true });
    await stream.iteration;
    expect(stream.packets).toEqual([
      { data: Buffer.from('init'), isLast: false },
      { data: Buffer.from('fragment'), isLast: false },
      { data: Buffer.from('final'), isLast: true },
    ]);
    expect(media.sessions[0].stop).toHaveBeenCalled();
  });

  it('advertises both recorded audio profiles and every sample rate it can produce', () => {
    const { controller } = attachRecordingCamera('Synthetic recording audio camera');
    const advertised = decodeTlvWithLists(
      Buffer.from(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.SupportedAudioRecordingConfiguration,
        ).value as string,
        'base64',
      ),
      1,
    );
    const codecs = (advertised[1] as Buffer[]).map((entry) => {
      const inner = decodeTlvWithLists(entry, 3);
      return {
        type: (inner[1] as Buffer)[0],
        rates: (decodeTlvWithLists(inner[2] as Buffer, 3)[3] as Buffer[]).map((rate) => rate[0]),
      };
    });
    expect(codecs.map(({ type }) => type)).toEqual([AudioRecordingCodecType.AAC_LC, AudioRecordingCodecType.AAC_ELD]);
    for (const { rates } of codecs) {
      expect(rates).toEqual([
        AudioRecordingSamplerate.KHZ_16,
        AudioRecordingSamplerate.KHZ_24,
        AudioRecordingSamplerate.KHZ_32,
        AudioRecordingSamplerate.KHZ_48,
      ]);
    }
  });

  it('records the audio profile and sample rate a controller selected', async () => {
    for (const [codec, rate, expected, expectedRate] of [
      [AudioRecordingCodecType.AAC_LC, AudioRecordingSamplerate.KHZ_48, 'AAC-lc', 48],
      [AudioRecordingCodecType.AAC_ELD, AudioRecordingSamplerate.KHZ_16, 'AAC-eld', 16],
    ] as const) {
      const media = recordingMedia();
      const connection = hapConnection();
      const { controller, delegate } = attachRecordingCamera(`Synthetic recording audio ${expected} ${expectedRate}`, {
        recordingMedia: media.adapter,
      });
      await selectRecordingConfiguration(controller, connection, { audioCodec: codec, samplerate: rate });
      controller.recordingManagement!.recordingManagementService.updateCharacteristic(
        Characteristic.RecordingAudioActive,
        true,
      );
      const stream = consumeRecordingStream(delegate, 61);
      await new Promise((resolve) => setImmediate(resolve));
      expect(media.negotiations[0].audio).toEqual({
        codec: expected,
        channels: 1,
        sampleRate: expectedRate,
        maxBitRate: 32,
      });
      media.sessions[0].push({ data: Buffer.from('final'), last: true });
      await stream.iteration;
    }
  });

  it('records no audio while HomeKit withdraws recording audio', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic muted recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection);
    expect(
      Boolean(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.RecordingAudioActive,
        ).value,
      ),
    ).toBe(false);

    const stream = consumeRecordingStream(delegate, 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0].audio).toBeUndefined();
    media.sessions[0].push({ data: Buffer.from('final'), last: true });
    await stream.iteration;
  });

  it('records no audio for a camera whose audio the user turned off', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic audio-disabled recording camera', {
      recordingMedia: media.adapter,
      audioEnabled: false,
    });
    await selectRecordingConfiguration(controller, connection);
    controller.recordingManagement!.recordingManagementService.updateCharacteristic(
      Characteristic.RecordingAudioActive,
      true,
    );
    const stream = consumeRecordingStream(delegate, 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0].audio).toBeUndefined();
    media.sessions[0].push({ data: Buffer.from('final'), last: true });
    await stream.iteration;
  });

  it('keeps a running recording on the configuration it started with', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic reselected recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection, { resolution: [1280, 720, 30] });
    const stream = consumeRecordingStream(delegate, 3);
    await new Promise((resolve) => setImmediate(resolve));
    await selectRecordingConfiguration(controller, connection, { resolution: [1920, 1080, 30] });
    media.sessions[0].push({ data: Buffer.from('final'), last: true });
    await stream.iteration;
    expect(media.negotiations).toHaveLength(1);
    expect(media.negotiations[0].width).toBe(1280);

    const next = consumeRecordingStream(delegate, 4);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[1].width).toBe(1920);
    media.sessions[1].push({ data: Buffer.from('final'), last: true });
    await next.iteration;
  });

  it('stops a recording the controller closed without yielding another packet', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic closed recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection);
    const stream = consumeRecordingStream(delegate, 9);
    await new Promise((resolve) => setImmediate(resolve));
    media.sessions[0].push({ data: Buffer.from('init'), last: false });
    await new Promise((resolve) => setImmediate(resolve));

    delegate.closeRecordingStream(9, HDSProtocolSpecificErrorReason.NORMAL);
    await stream.iteration;
    expect(media.sessions[0].stop).toHaveBeenCalled();
    expect(stream.packets).toEqual([{ data: Buffer.from('init'), isLast: false }]);
    expect(stream.failed()).toBe(false);
  });

  it('stops a recording whose abort signal fires', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate } = attachRecordingCamera('Synthetic aborted recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection);
    const abort = new AbortController();
    const stream = consumeRecordingStream(delegate, 11, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await stream.iteration;
    expect(media.sessions[0].stop).toHaveBeenCalled();
  });

  it('refuses a recording while the admitted enabled observation says the camera is disabled', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { state, camera } = observedCamera(false);
    const accessory = new Accessory(
      'Synthetic disabled recording camera',
      uuid.generate('synthetic-disabled-recording-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const diagnose = vi.fn();
    const observed = vi.fn();
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => Object.assign(camera, { recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(enabledEvidence(new Map())),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: media.adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      diagnose,
      observed,
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;
    await selectRecordingConfiguration(controller, connection);

    const refused = consumeRecordingStream(controller.recordingManagement!.delegate, 21);
    await refused.iteration;
    expect(refused.failed()).toBe(true);
    expect(media.negotiations).toEqual([]);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-recording-refused'),
    ).toEqual([
      {
        code: 'camera-recording-refused',
        capability: 'camera',
        member: 'recordFragments',
        active: true,
        reason: 'disabled',
      },
    ]);

    state.value = true;
    const admitted = consumeRecordingStream(controller.recordingManagement!.delegate, 22);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations).toHaveLength(1);
    expect(observed).toHaveBeenCalledWith('camera-recording-refused');
    media.sessions[0].push({ data: Buffer.from('final'), last: true });
    await admitted.iteration;
  });

  it('latches one recording failure reason and clears it when a later recording produces output', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const { controller, delegate, diagnose, observed } = attachRecordingCamera('Synthetic failing recording camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, connection);

    const failing = consumeRecordingStream(delegate, 31);
    await new Promise((resolve) => setImmediate(resolve));
    media.report({ outcome: 'failed', reason: 'no-output-within-backstop' });
    media.sessions[0].fail(new Error('synthetic adaptation failure'));
    await failing.iteration;
    expect(failing.failed()).toBe(true);
    expect(
      diagnose.mock.calls.map(([condition]) => condition).filter(({ code }) => code === 'camera-recording-failed'),
    ).toEqual([
      {
        code: 'camera-recording-failed',
        capability: 'camera',
        member: 'recordFragments',
        active: true,
        reason: 'no-output-within-backstop',
      },
    ]);

    const recovered = consumeRecordingStream(delegate, 32);
    await new Promise((resolve) => setImmediate(resolve));
    media.report({ outcome: 'recording' });
    expect(observed).toHaveBeenCalledWith('camera-recording-failed');
    media.sessions[1].push({ data: Buffer.from('final'), last: true });
    await recovered.iteration;
  });

  it('reports the recording state HomeKit persists without holding a source warm for it', () => {
    const media = recordingMedia();
    const { delegate } = attachRecordingCamera('Synthetic recording state camera', { recordingMedia: media.adapter });
    delegate.updateRecordingActive(true);
    delegate.updateRecordingConfiguration(undefined);
    expect(media.negotiations).toEqual([]);
    expect(media.sessions).toEqual([]);
  });

  it('opens a mains-powered camera source with the pre-event window a recording drains', async () => {
    const media = recordingMedia();
    const streaming = liveMedia();
    const live = vi.fn();
    const { controller, delegate } = attachRecordingCamera('Synthetic prebuffered recording camera', {
      recordingMedia: media.adapter,
      liveMedia: streaming.adapter,
      audioEnabled: false,
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live, recordFragments: vi.fn() }) } as never,
    });
    await selectRecordingConfiguration(controller, hapConnection(), { prebufferLength: 4_000 });

    const stream = consumeRecordingStream(delegate, 61);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0]).toMatchObject({ prebufferLengthMs: 4_000 });

    await startLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate);
    await streaming.started[0].live();
    expect(live).toHaveBeenCalledWith({ preBufferSeconds: 4 });

    media.sessions[0].push({ data: Buffer.from('prebuffered'), last: true });
    await stream.iteration;
  });

  it('opens a mains-powered live snapshot with the same pre-event window as live view', async () => {
    const snapshotLive = vi.fn(async () => ({
      jpeg: jpeg('synthetic prebuffered snapshot'),
      width: 1280,
      height: 720,
    }));
    const { controller } = attachRecordingCamera('Synthetic prebuffered snapshot camera', {
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({ live: vi.fn(), snapshotLive, recordFragments: vi.fn() }),
      } as never,
      evidence: recordingEvidence(snapshotEvidence('snapshotLive')),
    });

    await callSnapshot((controller as { delegate: CameraStreamingDelegate }).delegate);

    expect(snapshotLive).toHaveBeenCalledWith({ preBufferSeconds: 4 });
  });

  it('never retains pre-event media for a battery or solar camera', async () => {
    const media = recordingMedia();
    const streaming = liveMedia();
    const live = vi.fn();
    const { controller, delegate } = attachRecordingCamera('Synthetic battery recording camera', {
      recordingMedia: media.adapter,
      liveMedia: streaming.adapter,
      audioEnabled: false,
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live, recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(
        new Map([
          [
            'battery.level.read',
            { id: 'battery.level.read', kind: 'read' as const, type: 'number' as const, writable: false },
          ],
        ]),
      ),
    });
    await selectRecordingConfiguration(controller, hapConnection(), { prebufferLength: 4_000 });

    const stream = consumeRecordingStream(delegate, 62);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0]).toMatchObject({ prebufferLengthMs: 0 });

    await startLiveSession((controller as { delegate: CameraStreamingDelegate }).delegate);
    await streaming.started[0].live();
    expect(live).toHaveBeenCalledWith(undefined);

    media.sessions[0].push({ data: Buffer.from('battery'), last: true });
    await stream.iteration;
  });

  it('opens a battery or solar live snapshot without a pre-event window', async () => {
    const snapshotLive = vi.fn(async () => ({ jpeg: jpeg('synthetic battery snapshot'), width: 1280, height: 720 }));
    const { controller } = attachRecordingCamera('Synthetic battery snapshot camera', {
      device: {
        sn: SNAPSHOT_SERIAL,
        camera: () => ({ live: vi.fn(), snapshotLive, recordFragments: vi.fn() }),
      } as never,
      evidence: recordingEvidence(
        new Map([
          ...snapshotEvidence('snapshotLive'),
          [
            'battery.level.read',
            { id: 'battery.level.read', kind: 'read' as const, type: 'number' as const, writable: false },
          ],
        ]),
      ),
    });

    await callSnapshot((controller as { delegate: CameraStreamingDelegate }).delegate);

    expect(snapshotLive).toHaveBeenCalledWith(undefined);
  });

  it('retains no pre-event media for a camera with no recording to drain it', async () => {
    const accessory = new Accessory(
      'Synthetic unrecorded prebuffer camera',
      uuid.generate('synthetic-unrecorded-prebuffer'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const streaming = liveMedia();
    const live = vi.fn();
    const snapshotLive = vi.fn(async () => ({ jpeg: jpeg('synthetic unrecorded snapshot'), width: 1280, height: 720 }));
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live, snapshotLive, recordFragments: vi.fn() }) } as never,
      evidence: recordingEvidence(snapshotEvidence('snapshotLive')),
      accessory,
      hap: HAP,
      liveMedia: streaming.adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      snapshotMode: 'Refresh',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    expect(controller.recordingManagement).toBeUndefined();
    await startLiveSession(controller.delegate, 'synthetic-unrecorded-prebuffer-session');
    await streaming.started[0].live();
    expect(live).toHaveBeenCalledWith(undefined);
    await callSnapshot(controller.delegate);
    expect(snapshotLive).toHaveBeenCalledWith(undefined);
  });

  it('asks for no more pre-event media than the window the camera retains', async () => {
    const media = recordingMedia();
    const { controller, delegate } = attachRecordingCamera('Synthetic overselected prebuffer camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, hapConnection(), { prebufferLength: 8_000 });

    const stream = consumeRecordingStream(delegate, 63);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0]).toMatchObject({ prebufferLengthMs: 4_000 });

    media.sessions[0].push({ data: Buffer.from('clamped'), last: true });
    await stream.iteration;
  });

  it('asks for only the shorter pre-event window a controller selected', async () => {
    const media = recordingMedia();
    const { controller, delegate } = attachRecordingCamera('Synthetic short prebuffer camera', {
      recordingMedia: media.adapter,
    });
    await selectRecordingConfiguration(controller, hapConnection(), { prebufferLength: 2_000 });

    const stream = consumeRecordingStream(delegate, 64);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations[0]).toMatchObject({ prebufferLengthMs: 2_000 });

    media.sessions[0].push({ data: Buffer.from('short'), last: true });
    await stream.iteration;
  });

  it('refuses a recording after a reconciliation withdraws the camera fragment recording', async () => {
    const media = recordingMedia();
    const connection = hapConnection();
    const accessory = new Accessory(
      'Synthetic withdrawn recording camera',
      uuid.generate('synthetic-withdrawn-recording-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    const attach = (evidence: AdapterAttachmentContext['evidence']): void => {
      CAMERA_STREAMING_ADAPTER.attach({
        device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), recordFragments: vi.fn() }) } as never,
        evidence,
        accessory,
        hap: HAP,
        liveMedia: { prepare: vi.fn() },
        recordingMedia: media.adapter,
        snapshotMedia: new SnapshotAcquisition(retainedImages([])),
        diagnose: vi.fn(),
        observed: vi.fn(),
        persist: vi.fn(),
      } satisfies AdapterAttachmentContext);
    };
    attach(recordingEvidence());
    const controller = configureController.mock.calls[0][0] as CameraController;
    const delegate = controller.recordingManagement!.delegate;
    await selectRecordingConfiguration(controller, connection);

    const running = consumeRecordingStream(delegate, 51);
    await new Promise((resolve) => setImmediate(resolve));
    expect(media.negotiations).toHaveLength(1);

    attach(new Map());
    await running.iteration;
    expect(media.sessions[0].stop).toHaveBeenCalled();

    const refused = consumeRecordingStream(delegate, 52);
    await refused.iteration;
    expect(refused.failed()).toBe(true);
    expect(media.negotiations).toHaveLength(1);
  });

  it('advertises a press as a recording trigger for a camera whose doorbell press is admitted', () => {
    const media = recordingMedia();
    const accessory = new Accessory(
      'Synthetic recording doorbell',
      uuid.generate('synthetic-recording-doorbell'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), recordFragments: vi.fn() }) } as never,
      evidence: new Map([
        ...recordingEvidence(new Map(), { trigger: false }),
        ['doorbell.doorbellPress.event', { id: 'doorbell.doorbellPress.event', kind: 'event' as const }],
      ]),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: media.adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;
    expect(controller.controllerId()).toBe('camera');
    expect(accessory.services.map((service) => service.UUID)).not.toContain(Service.MotionSensor.UUID);
    expect(accessory.services.map((service) => service.UUID)).not.toContain(Service.Microphone.UUID);
    const advertised = decodeTlv(
      Buffer.from(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.SupportedCameraRecordingConfiguration,
        ).value as string,
        'base64',
      ),
    );
    expect(advertised[2].readInt32LE(0)).toBe(EventTriggerOption.DOORBELL);
  });

  it('advertises both triggers for a doorbell that also reports motion', () => {
    const media = recordingMedia();
    const accessory = new Accessory(
      'Synthetic recording doorbell with motion',
      uuid.generate('synthetic-recording-doorbell-motion'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(accessory, 'configureController');
    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ live: vi.fn(), recordFragments: vi.fn() }) } as never,
      evidence: new Map([
        ...recordingEvidence(),
        ['doorbell.doorbellPress.event', { id: 'doorbell.doorbellPress.event', kind: 'event' as const }],
      ]),
      accessory,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      recordingMedia: media.adapter,
      snapshotMedia: new SnapshotAcquisition(retainedImages([])),
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController;
    const advertised = decodeTlv(
      Buffer.from(
        controller.recordingManagement!.recordingManagementService.getCharacteristic(
          Characteristic.SupportedCameraRecordingConfiguration,
        ).value as string,
        'base64',
      ),
    );
    expect(advertised[2].readInt32LE(0)).toBe(EventTriggerOption.MOTION | EventTriggerOption.DOORBELL);
    expect(accessory.services.filter((service) => service.UUID === Service.MotionSensor.UUID)).toHaveLength(1);
    expect(accessory.services.map((service) => service.UUID)).not.toContain(Service.Doorbell.UUID);

    DOORBELL_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL } as never,
      evidence: new Map([['doorbell.doorbellPress.event', { id: 'doorbell.doorbellPress.event', kind: 'event' }]]),
      accessory,
      hap: HAP,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    expect(accessory.services.filter((service) => service.UUID === Service.Doorbell.UUID)).toHaveLength(1);
  });

  it('refuses a recording stream before any configuration has been selected', async () => {
    const media = recordingMedia();
    const { delegate } = attachRecordingCamera('Synthetic unconfigured recording camera', {
      recordingMedia: media.adapter,
    });
    const stream = consumeRecordingStream(delegate, 41);
    await stream.iteration;
    expect(stream.failed()).toBe(true);
    expect(media.negotiations).toEqual([]);
  });
});

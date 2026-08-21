import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import type { CameraActions } from '@mega-yfue/eufy-sdk';
import {
  Accessory,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  Characteristic,
  decode as decodeTlv,
  decodeWithLists as decodeTlvWithLists,
  encode as encodeTlv,
  H264Level,
  H264Profile,
  HAPStatus,
  HapStatusError,
  readUInt16,
  Service,
  SRTPCryptoSuites,
  StreamRequestTypes,
  uuid,
  writeUInt16,
} from '@homebridge/hap-nodejs';
import type {
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamRequest,
  PrepareStreamResponse,
  StreamingRequest,
} from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterAttachmentContext, LiveSessionOutcome, PreparedLiveMedia } from '../../src/homekit/adapter.js';
import type { DeviceMemberEvidence } from '../../src/device/member-evidence.js';
import { CAMERA_STREAMING_ADAPTER } from '../../src/homekit/adapters/camera-streaming.js';
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

/** The image this package ships for a camera whose snapshot cannot be acquired at all. */
const PACKAGED_PLACEHOLDER = readFileSync(new URL('../../media/Snapshot-Unavailable.jpg', import.meta.url));

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
      reason: 'no-acquisition',
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
      ).toEqual([]);
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

  it('serves Cloud snapshots only from passive SDK storage', async () => {
    const target = new Accessory(
      'Synthetic cloud snapshot camera',
      uuid.generate('synthetic-cloud-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const stored = Buffer.from('synthetic stored jpeg');
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
    const first = Buffer.from('synthetic first live jpeg');
    const second = Buffer.from('synthetic second live jpeg');
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
    resolveSnapshot({ jpeg: Buffer.from('synthetic admitted jpeg'), width: 1280, height: 720 });
    await expect(admittedRequest).resolves.toEqual(Buffer.from('synthetic admitted jpeg'));
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
      reason: 'no-acquisition',
    });
    expect(observed).not.toHaveBeenCalledWith('camera-snapshot-unavailable');

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(acquired);
    expect(observed).toHaveBeenCalledWith('camera-snapshot-unavailable');
    expect(snapshotStored).not.toHaveBeenCalled();
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

  it('drives negotiated prepare, start, reconfigure, and stop through the media seam', async () => {
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

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => camera } as never,
      evidence: snapshotEvidence(),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare },
      audioEnabled: true,
      diagnose: vi.fn(),
      observed: vi.fn(),
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

    await callStream(controller.delegate, {
      sessionID: request.sessionID,
      type: StreamRequestTypes.RECONFIGURE,
      video: { width: 640, height: 360, fps: 15, max_bit_rate: 150, rtcp_interval: 0.5 },
    });
    expect(reconfigure).toHaveBeenCalledWith(expect.objectContaining({ width: 640, height: 360, fps: 15 }));

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

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(PACKAGED_PLACEHOLDER);
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
    const prepare = vi.fn(async (transport: { onSessionOutcome?(outcome: LiveSessionOutcome): void }) => {
      reporters.push((outcome) => transport.onSessionOutcome?.(outcome));
      return {
        videoPort: 41000 + reporters.length,
        start: vi.fn(async () => undefined),
        reconfigure: vi.fn(),
        stop: vi.fn(),
      } satisfies PreparedLiveMedia;
    });
    const diagnose = vi.fn();
    const observed = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ live: vi.fn() }) } as never,
      evidence: snapshotEvidence(),
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

    await callPrepare(controller.delegate, prepareRequest('failed-session'));
    reporters[0]!({ outcome: 'failed', reason: 'no-video-within-backstop' });
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

    await callPrepare(controller.delegate, prepareRequest('streaming-session'));
    reporters[1]!({ outcome: 'streaming' });

    expect(observed).toHaveBeenCalledExactlyOnceWith('camera-live-session-failed');
    expect(liveConditions()).toHaveLength(1);
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain(SNAPSHOT_SERIAL);
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

    await expect(callSnapshot(controller.delegate)).resolves.toEqual(jpeg('synthetic disabled still'));

    state.value = true;
    await expect(setupEndpoints(management, connection, '4faf7f01-2ff6-4dea-9c1a-4d0b1e1a0007')).resolves.toEqual({
      status: SETUP_ENDPOINTS_SUCCESS,
      videoPort: 41000,
    });
    expect(observed).toHaveBeenCalledWith('camera-live-session-refused');
    expect(JSON.stringify(diagnose.mock.calls)).not.toContain(SNAPSHOT_SERIAL);
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

import type { CameraActions } from '@mega-yfue/eufy-sdk';
import {
  Accessory,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  Characteristic,
  H264Level,
  H264Profile,
  HAPStatus,
  HapStatusError,
  Service,
  SRTPCryptoSuites,
  StreamRequestTypes,
  uuid,
} from '@homebridge/hap-nodejs';
import type {
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamRequest,
  PrepareStreamResponse,
  StreamingRequest,
} from 'homebridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterAttachmentContext, PreparedLiveMedia } from '../../src/homekit/adapter.js';
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

  it('fails a Refresh snapshot without a last successful image or stored acquisition', async () => {
    const target = new Accessory(
      'Synthetic unavailable refresh camera',
      uuid.generate('synthetic-unavailable-refresh-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const { snapshotLive } = pendingLiveSnapshot();
    const diagnose = vi.fn();

    CAMERA_STREAMING_ADAPTER.attach({
      device: { sn: SNAPSHOT_SERIAL, camera: () => ({ snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
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
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).rejects.toThrow('no camera snapshot image is available');
    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith({
      code: 'camera-snapshot-capability-unavailable',
      capability: 'camera',
      member: 'snapshotStored',
      active: false,
      reason: 'recovered',
    });
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

  it('rejects a selected snapshot policy without its exact SDK evidence', async () => {
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

    await expect(callSnapshot(controller.delegate)).rejects.toThrow('stored camera snapshot is unavailable');
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

    await expect(callSnapshot(controller.delegate)).rejects.toThrow('live camera snapshot is unavailable');
    expect(snapshotLive).toHaveBeenCalledOnce();
    resolveSnapshot({ jpeg: Buffer.from('synthetic admitted jpeg'), width: 1280, height: 720 });
    await expect(admittedRequest).resolves.toEqual(Buffer.from('synthetic admitted jpeg'));
  });

  it('exposes a Live snapshot failure without falling back to stored imagery', async () => {
    const target = new Accessory(
      'Synthetic failed live snapshot camera',
      uuid.generate('synthetic-failed-live-snapshot-camera'),
    ) as unknown as PlatformAccessory;
    const configureController = vi.spyOn(target, 'configureController');
    const failure = new Error('synthetic live snapshot failure');
    const snapshotStored = vi.fn(async () => Buffer.from('synthetic stored jpeg'));
    const snapshotLive = vi.fn(async () => {
      throw failure;
    });

    CAMERA_STREAMING_ADAPTER.attach({
      device: { camera: () => ({ snapshotStored, snapshotLive, live: vi.fn() }) } as never,
      evidence: snapshotEvidence('snapshotLive'),
      accessory: target,
      hap: HAP,
      liveMedia: { prepare: vi.fn() },
      snapshotMedia: new SnapshotAcquisition(),
      snapshotMode: 'Live',
      audioEnabled: false,
      diagnose: vi.fn(),
      observed: vi.fn(),
      persist: vi.fn(),
    } satisfies AdapterAttachmentContext);
    const controller = configureController.mock.calls[0][0] as CameraController & {
      delegate: CameraStreamingDelegate;
    };

    await expect(callSnapshot(controller.delegate)).rejects.toBe(failure);
    expect(snapshotLive).toHaveBeenCalledOnce();
    expect(snapshotStored).not.toHaveBeenCalled();
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
});

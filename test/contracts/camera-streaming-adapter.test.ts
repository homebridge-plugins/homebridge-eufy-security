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
import { describe, expect, it, vi } from 'vitest';

import type { AdapterAttachmentContext, PreparedLiveMedia } from '../../src/homekit/adapter.js';
import { CAMERA_STREAMING_ADAPTER } from '../../src/homekit/adapters/camera-streaming.js';

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

describe('camera streaming bundle adapter', () => {
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
      evidence: new Map([
        ['camera.live.momentary-action', { id: 'camera.live.momentary-action', kind: 'momentary-action' }],
      ]),
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
      evidence: new Map([
        ['camera.live.momentary-action', { id: 'camera.live.momentary-action', kind: 'momentary-action' }],
      ]),
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

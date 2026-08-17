import type { CameraActions } from '@mega-yfue/eufy-sdk';
import type {
  CameraController,
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';

import type {
  AdapterAttachmentContext,
  AttachedAdapter,
  HomeKitAdapter,
  LiveMediaAdapter,
  NegotiatedLiveVideo,
  PreparedLiveMedia,
} from '../adapter.js';

export const CAMERA_STREAMING_ADAPTER_KEY = 'camera.streaming';

const CAMERA_LIVE = {
  id: 'camera.live.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_STREAMING_OWNERS = new WeakMap<object, symbol>();
const CAMERA_STREAMING_STATES = new WeakMap<
  object,
  { owner: symbol; controller: CameraController; delegate: LiveCameraDelegate }
>();

/** The typed SDK camera media accessor consumed by the live bundle. */
export interface CameraStreamingSdkDevice {
  camera?: () => CameraActions | undefined;
}

/** Complete HomeKit RTP policy for an exactly evidenced SDK live-camera action. */
export const CAMERA_STREAMING_ADAPTER = {
  key: CAMERA_STREAMING_ADAPTER_KEY,
  role: 'primary-purpose',
  requires: [CAMERA_LIVE],
  coverage: [
    {
      id: CAMERA_LIVE.id,
      hapFit: 'Official Camera RTP Stream Management exposes negotiated live video and optional audio',
      identityEffect: 'Primary-purpose live media configures one stable camera controller on the accessory container',
      diagnostics: 'Missing typed live media or adaptation fails closed without a raw-stream fallback',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'drives negotiated prepare, start, reconfigure, and stop through the media seam',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'starts and retains video when source audio is absent or its separate process fails',
        },
      ],
    },
  ],
  attach: attachCameraStreaming,
} as const satisfies HomeKitAdapter;

function attachCameraStreaming(context: AdapterAttachmentContext): AttachedAdapter | undefined {
  const device = context.device as CameraStreamingSdkDevice;
  let camera: CameraActions | undefined;
  try {
    camera = device.camera?.();
  } catch {
    context.diagnose(unavailable(true, 'sdk-fault'));
    return undefined;
  }
  if (!camera || typeof camera.live !== 'function' || !context.liveMedia) {
    context.diagnose(unavailable(true, !camera || typeof camera.live !== 'function' ? 'missing' : 'adapter-missing'));
    return undefined;
  }
  context.diagnose(unavailable(false, 'recovered'));

  const source = { live: camera.live.bind(camera) };
  const existing = CAMERA_STREAMING_STATES.get(context.accessory);
  const owner = Symbol('camera-streaming-owner');
  if (existing) {
    existing.owner = owner;
    existing.delegate.update(source, context.liveMedia, context.audioEnabled !== false);
    CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
    return attachment(context, existing.controller, existing.delegate, owner);
  }

  const delegate = new LiveCameraDelegate(source, context.liveMedia, context.audioEnabled !== false, context.hap);
  const controller = new context.hap.CameraController(
    {
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [context.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [context.hap.H264Profile.BASELINE, context.hap.H264Profile.MAIN, context.hap.H264Profile.HIGH],
            levels: [context.hap.H264Level.LEVEL3_1, context.hap.H264Level.LEVEL3_2, context.hap.H264Level.LEVEL4_0],
          },
          resolutions: [
            [320, 180, 15],
            [640, 360, 30],
            [1280, 720, 30],
            [1920, 1080, 30],
          ],
        },
        ...(context.audioEnabled === false
          ? {}
          : {
              audio: {
                codecs: [
                  {
                    type: context.hap.AudioStreamingCodecType.AAC_ELD,
                    audioChannels: 1,
                    bitrate: 0,
                    samplerate: [
                      context.hap.AudioStreamingSamplerate.KHZ_16,
                      context.hap.AudioStreamingSamplerate.KHZ_24,
                    ],
                  },
                ],
              },
            }),
      },
    },
    true,
  );
  delegate.controller = controller;
  context.accessory.configureController(controller);
  CAMERA_STREAMING_STATES.set(context.accessory, { owner, controller, delegate });
  CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
  return attachment(context, controller, delegate, owner);
}

function attachment(
  context: AdapterAttachmentContext,
  controller: CameraController,
  delegate: LiveCameraDelegate,
  owner: symbol,
): AttachedAdapter {
  return {
    detach(): void {
      if (CAMERA_STREAMING_OWNERS.get(context.accessory) !== owner) {
        return;
      }
      CAMERA_STREAMING_OWNERS.delete(context.accessory);
      CAMERA_STREAMING_STATES.delete(context.accessory);
      delegate.stop();
      context.accessory.removeController(controller);
    },
  };
}

function unavailable(active: boolean, reason: string) {
  return {
    code: 'camera-streaming-capability-unavailable',
    capability: 'camera',
    member: 'live',
    active,
    reason,
  };
}

interface PendingSession {
  prepared: PreparedLiveMedia;
  videoSsrc: number;
  audioSsrc?: number;
  selection?: StartStreamRequest;
}

/** Owns HomeKit camera negotiation while delegating source adaptation to the media domain. */
class LiveCameraDelegate implements CameraStreamingDelegate {
  controller?: CameraController;
  private readonly sessions = new Map<string, PendingSession>();
  private readonly prepareGenerations = new Map<string, symbol>();
  private acceptingSessions = true;

  constructor(
    private source: { live(): ReturnType<NonNullable<CameraActions['live']>> },
    private media: LiveMediaAdapter,
    private audioEnabled: boolean,
    private readonly hap: AdapterAttachmentContext['hap'],
  ) {}

  update(
    source: { live(): ReturnType<NonNullable<CameraActions['live']>> },
    media: LiveMediaAdapter,
    audioEnabled: boolean,
  ): void {
    this.source = source;
    this.media = media;
    this.audioEnabled = audioEnabled;
    this.acceptingSessions = true;
  }

  handleSnapshotRequest(_request: never, callback: (error?: Error, buffer?: Buffer) => void): void {
    callback(new Error('live camera snapshots are not admitted by this adapter'));
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const generation = Symbol('camera-stream-prepare');
    this.prepareGenerations.set(request.sessionID, generation);
    void this.prepare(request).then(
      ({ response, session }) => {
        if (!this.acceptingSessions || this.prepareGenerations.get(request.sessionID) !== generation) {
          session.prepared.stop();
          callback(new Error('live media preparation was cancelled'));
          return;
        }
        this.prepareGenerations.delete(request.sessionID);
        const replaced = this.sessions.get(request.sessionID);
        replaced?.prepared.stop();
        this.sessions.set(request.sessionID, session);
        callback(undefined, response);
      },
      (error: unknown) => {
        if (this.prepareGenerations.get(request.sessionID) === generation) {
          this.prepareGenerations.delete(request.sessionID);
        }
        callback(error instanceof Error ? error : new Error('failed to prepare live media'));
      },
    );
  }

  private async prepare(request: PrepareStreamRequest) {
    const videoSsrc = this.hap.CameraController.generateSynchronisationSource();
    const audioSsrc = this.audioEnabled ? this.hap.CameraController.generateSynchronisationSource() : undefined;
    const prepared = await this.media.prepare({
      addressVersion: request.addressVersion,
      targetAddress: request.targetAddress,
      video: mediaTarget(request.video, this.hap),
      ...(this.audioEnabled ? { audio: mediaTarget(request.audio, this.hap) } : {}),
      onVideoFailure: () => this.controller?.forceStopStreamingSession(request.sessionID),
    });
    return {
      session: { prepared, videoSsrc, ...(audioSsrc === undefined ? {} : { audioSsrc }) },
      response: {
        video: {
          port: prepared.videoPort,
          ssrc: videoSsrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        ...(prepared.audioPort === undefined || audioSsrc === undefined
          ? {}
          : {
              audio: {
                port: prepared.audioPort,
                ssrc: audioSsrc,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt,
              },
            }),
      },
    };
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const session = this.sessions.get(request.sessionID);
    if (request.type === 'stop') {
      this.prepareGenerations.delete(request.sessionID);
      session?.prepared.stop();
      this.sessions.delete(request.sessionID);
      callback();
      return;
    }
    if (!session) {
      callback(new Error('live media session was not prepared'));
      return;
    }
    if (request.type === 'reconfigure') {
      if (!session.selection) {
        callback(new Error('live media session has not started'));
        return;
      }
      const video = negotiatedVideo({ ...session.selection.video, ...request.video }, session.videoSsrc, this.hap);
      session.prepared.reconfigure(video);
      session.selection = { ...session.selection, video: { ...session.selection.video, ...request.video } };
      callback();
      return;
    }
    session.selection = request;
    void session.prepared
      .start(this.source, {
        video: negotiatedVideo(request.video, session.videoSsrc, this.hap),
        ...(this.audioEnabled && session.audioSsrc !== undefined
          ? {
              audio: {
                codec: 'AAC-eld' as const,
                channels: request.audio.channel,
                sampleRate: request.audio.sample_rate === this.hap.AudioStreamingSamplerate.KHZ_24 ? 24 : 16,
                maxBitRate: request.audio.max_bit_rate,
                payloadType: request.audio.pt,
                ssrc: session.audioSsrc,
              },
            }
          : {}),
      })
      .then(
        () => callback(),
        (error: unknown) => callback(error instanceof Error ? error : new Error('stream failed')),
      );
  }

  stop(): void {
    this.acceptingSessions = false;
    this.prepareGenerations.clear();
    for (const session of this.sessions.values()) {
      session.prepared.stop();
    }
    this.sessions.clear();
  }
}

function mediaTarget(source: PrepareStreamRequest['video'], hap: AdapterAttachmentContext['hap']) {
  const suite =
    source.srtpCryptoSuite === hap.SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80
      ? 'AES_CM_256_HMAC_SHA1_80'
      : 'AES_CM_128_HMAC_SHA1_80';
  return {
    port: source.port,
    srtpCryptoSuite: suite as 'AES_CM_128_HMAC_SHA1_80' | 'AES_CM_256_HMAC_SHA1_80',
    srtpKey: source.srtp_key,
    srtpSalt: source.srtp_salt,
  };
}

function negotiatedVideo(
  video: StartStreamRequest['video'],
  ssrc: number,
  hap: AdapterAttachmentContext['hap'],
): NegotiatedLiveVideo {
  return {
    width: video.width,
    height: video.height,
    fps: video.fps,
    maxBitRate: video.max_bit_rate,
    profile:
      video.profile === hap.H264Profile.HIGH ? 'high' : video.profile === hap.H264Profile.MAIN ? 'main' : 'baseline',
    level: video.level === hap.H264Level.LEVEL4_0 ? '4.0' : video.level === hap.H264Level.LEVEL3_2 ? '3.2' : '3.1',
    payloadType: video.pt,
    ssrc,
    mtu: video.mtu,
    rtcpInterval: video.rtcp_interval,
  };
}

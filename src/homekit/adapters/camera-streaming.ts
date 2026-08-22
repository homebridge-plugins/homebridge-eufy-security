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

import { satisfiesMemberRequirements } from '../../device/member-evidence.js';
import type {
  AdapterAttachmentContext,
  AttachedAdapter,
  HomeKitAdapter,
  LiveMediaAdapter,
  LiveSessionOutcome,
  NegotiatedLiveVideo,
  PreparedLiveMedia,
  SnapshotMediaAdapter,
  SnapshotMode,
} from '../adapter.js';

export const CAMERA_STREAMING_ADAPTER_KEY = 'camera.streaming';

const CAMERA_LIVE_SESSION_CONDITION = 'camera-live-session-failed';
const CAMERA_LIVE_REFUSED_CONDITION = 'camera-live-session-refused';
const CAMERA_SNAPSHOT_UNAVAILABLE_CONDITION = 'camera-snapshot-unavailable';

/**
 * The exact enablement observation a live session is admitted against. The row itself belongs to the
 * camera controls bundle; this bundle only consumes it, and only when the manifest reports it as a
 * boolean read, because no other member shape carries that meaning.
 */
const CAMERA_ENABLED_READ = { id: 'camera.enabled.read', kind: 'read', type: 'bool' } as const;

/**
 * How often an active live session re-reads the enablement observation. The SDK reports no event for it,
 * so a session is supervised by reading rather than by waiting; the read is an in-memory one whose own
 * staleness policy bounds how often it reaches the network, so the tick period buys detection latency
 * without buying requests.
 */
const ENABLEMENT_SUPERVISION_INTERVAL_MS = 5_000;

const CAMERA_LIVE = {
  id: 'camera.live.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_SNAPSHOT_STORED = {
  id: 'camera.snapshotStored.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_SNAPSHOT_LIVE = {
  id: 'camera.snapshotLive.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_STREAMING_OWNERS = new WeakMap<object, symbol>();
const CAMERA_STREAMING_STATES = new WeakMap<
  object,
  { owner: symbol; controller: CameraController; delegate: LiveCameraDelegate }
>();

/** The typed SDK camera media accessor consumed by the live bundle. */
export interface CameraStreamingSdkDevice {
  readonly sn: string;
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
      diagnostics:
        'Missing typed live media or adaptation fails closed without a raw-stream fallback, a session that ends without usable video latches one bounded reason until a later session streams, and a camera an admitted observation reports as disabled latches one bounded refusal reason without opening a transport',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'advertises exactly the profile, level, and resolution matrix a live run may select',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'drives negotiated prepare, start, reconfigure, and stop through the media seam',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves a snapshot during an active live session without disturbing its media',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves a retained image during an active live session without waiting for a live acquisition',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'keeps two concurrent negotiated sessions independent on one camera',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'holds a prepared session that never starts until its HAP connection closes',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'forgets a session HomeKit closed after a video failure instead of restarting its media',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'latches one live-session failure reason and clears it when a later session streams',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a live session while the admitted enabled observation says the camera is disabled',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'gates a live session only on an exactly evidenced boolean enablement observation',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a start for a camera observed disabled after its session was prepared',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'terminates an active session and stops its media when the camera is later observed disabled',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'transcodes H.264 when passthrough compliance cannot be proven from SDK frames',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'timestamps live video by arrival and bounds the analysis that precedes a first coded frame',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'tells only a raw a-law input the sample rate assumption its format cannot carry',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'requests the global header AAC-ELD needs to leave the encoder at all',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'starts and retains video when source audio is absent or its separate process fails',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'applies a reconfigured selection to adaptation while keeping the negotiated RTP identity',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'keeps the previous selection on the wire until a reconfigured one has a keyframe to start from',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'readapts a changed source codec at its next keyframe without changing negotiated output',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'bounds a deferred reconfiguration even while the superseded selection keeps reporting progress',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'starts adaptation for a first keyframe delivered after the SDK warm-up window',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'fails a session on the SDK warm-up error before the video backstop',
        },
      ],
    },
    {
      id: CAMERA_SNAPSHOT_STORED.id,
      hapFit:
        'Official camera snapshot requests consume only the passive stored SDK image in Cloud mode and when Refresh has no retained image, and consume nothing at all while an admitted observation reports the camera disabled',
      identityEffect: 'Stored snapshots use the stable camera controller without creating another service',
      diagnostics:
        'Cloud never substitutes live media and Refresh reports missing stored acquisition only when live refresh is also unavailable; a request no admitted acquisition can answer serves the packaged unavailable image and latches one bounded reason until a later real image withdraws it',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves Cloud snapshots only from passive SDK storage',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'acquires a stored-only Refresh image when no last successful image exists',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves the packaged unavailable placeholder when no admitted acquisition can answer',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves the packaged disabled image without acquiring or serving a real one while a camera is off',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'never implies a disabled camera from a missing or malformed enablement observation',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'fails a snapshot request when this package carries no usable placeholder',
        },
        {
          file: 'test/contracts/last-successful-image.test.ts',
          behavior: 'keeps a live image ahead of stored-only replacement for two minutes',
        },
      ],
    },
    {
      id: CAMERA_SNAPSHOT_LIVE.id,
      hapFit:
        'Official camera snapshot requests consume a fresh SDK live still in Live mode and one rate-limited refresh in Refresh mode',
      identityEffect: 'Live snapshots use the stable camera controller without creating another service',
      diagnostics:
        'Live never falls back to stored imagery and Refresh reports missing live acquisition only when stored acquisition is also unavailable; a failed acquisition serves the packaged unavailable image rather than an image from another camera path',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'coalesces only concurrent Live snapshots and otherwise acquires a fresh image',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves a Refresh snapshot from the last successful image and rate-limits live refresh',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'serves the placeholder for a failed Live acquisition without falling back to stored imagery',
        },
        {
          file: 'test/contracts/last-successful-image.test.ts',
          behavior: 'stores a validated image atomically under an owner-only opaque name',
        },
        {
          file: 'test/contracts/last-successful-image.test.ts',
          behavior: 'survives restart and full Homebridge backup restoration',
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

  const snapshotMode = context.snapshotMode ?? 'Refresh';
  const storedEvidence = context.evidence.has(CAMERA_SNAPSHOT_STORED.id);
  const liveEvidence = context.evidence.has(CAMERA_SNAPSHOT_LIVE.id);
  const storedAvailable = storedEvidence && typeof camera.snapshotStored === 'function';
  const liveAvailable = liveEvidence && typeof camera.snapshotLive === 'function';
  const storedReason = !context.snapshotMedia
    ? 'adapter-missing'
    : !storedEvidence
      ? 'missing-evidence'
      : storedAvailable
        ? 'recovered'
        : 'missing';
  const liveReason = !context.snapshotMedia
    ? 'adapter-missing'
    : !liveEvidence
      ? 'missing-evidence'
      : liveAvailable
        ? 'recovered'
        : 'missing';
  const requiresStored = snapshotMode === 'Cloud' || (snapshotMode === 'Refresh' && !liveAvailable);
  const requiresLive = snapshotMode === 'Live' || (snapshotMode === 'Refresh' && !storedAvailable);
  context.diagnose(snapshotUnavailable(requiresStored && storedReason !== 'recovered', 'snapshotStored', storedReason));
  context.diagnose(snapshotUnavailable(requiresLive && liveReason !== 'recovered', 'snapshotLive', liveReason));
  const source: CameraMediaSource = {
    live: camera.live.bind(camera),
    ...(storedAvailable ? { snapshotStored: camera.snapshotStored!.bind(camera) } : {}),
    ...(liveAvailable ? { snapshotLive: camera.snapshotLive!.bind(camera) } : {}),
  };
  const existing = CAMERA_STREAMING_STATES.get(context.accessory);
  const owner = Symbol('camera-streaming-owner');
  const binding: LiveCameraBinding = {
    source,
    media: context.liveMedia,
    ...(context.snapshotMedia ? { snapshotMedia: context.snapshotMedia } : {}),
    audioEnabled: context.audioEnabled !== false,
    snapshotMode,
    enablement: enablementObservation(context, camera),
    reportSession: liveSessionReporter(context),
    reportAdmission: cameraLiveCondition(context, CAMERA_LIVE_REFUSED_CONDITION),
    reportSnapshot: cameraCondition(context, CAMERA_SNAPSHOT_UNAVAILABLE_CONDITION, 'snapshot'),
  };
  if (existing) {
    existing.owner = owner;
    existing.delegate.update(binding);
    CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
    return attachment(context, existing.controller, existing.delegate, owner);
  }

  const delegate = new LiveCameraDelegate(device.sn, binding, context.hap);
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

function snapshotUnavailable(active: boolean, member: 'snapshotStored' | 'snapshotLive', reason: string) {
  return {
    code: 'camera-snapshot-capability-unavailable',
    capability: 'camera',
    member,
    active,
    reason: active ? reason : 'recovered',
  };
}

/**
 * Latches why the most recent live session ended without usable video and clears that condition once a
 * later session reaches the negotiated output.
 */
function liveSessionReporter(context: AdapterAttachmentContext): (outcome: LiveSessionOutcome) => void {
  const condition = cameraLiveCondition(context, CAMERA_LIVE_SESSION_CONDITION);
  return (outcome) => condition(outcome.outcome === 'streaming' ? undefined : outcome.reason);
}

/**
 * Latches one bounded reason for a camera live condition and withdraws it when the condition recovers.
 * Only the reason vocabulary its caller owns is reported; no device identity, address, key, media byte, or
 * SDK message crosses this seam.
 */
function cameraCondition(context: AdapterAttachmentContext, code: string, member: string): (reason?: string) => void {
  return (reason) => {
    if (reason === undefined) {
      context.observed(code);
      return;
    }
    context.diagnose({ code, capability: 'camera', member, active: true, reason });
  };
}

function cameraLiveCondition(context: AdapterAttachmentContext, code: string): (reason?: string) => void {
  return cameraCondition(context, code, 'live');
}

/**
 * Reads whether this camera is enabled, or nothing at all when it has no such observation.
 *
 * The SDK exposes enablement as an evidence-gated boolean read and privacy mode as a write with no
 * readback, so enablement is the only observation live admission can consult. The requirement deliberately
 * does not demand a writable member, because a camera that reports its state without accepting a change is
 * still observed. A camera whose manifest omits the row, whose value is not a boolean, or whose read faults
 * is treated as unobserved and streams exactly as it would without the gate, because refusing on an absent
 * observation would withdraw live view from a working camera.
 */
function enablementObservation(context: AdapterAttachmentContext, camera: CameraActions): () => boolean | undefined {
  if (!satisfiesMemberRequirements(context.evidence, [CAMERA_ENABLED_READ])) {
    return () => undefined;
  }
  return () => {
    try {
      return typeof camera.enabled === 'boolean' ? camera.enabled : undefined;
    } catch {
      return undefined;
    }
  };
}

interface PendingSession {
  prepared: PreparedLiveMedia;
  videoSsrc: number;
  audioSsrc?: number;
  selection?: StartStreamRequest;
}

interface CameraMediaSource {
  live(): ReturnType<NonNullable<CameraActions['live']>>;
  snapshotStored?(): ReturnType<NonNullable<CameraActions['snapshotStored']>>;
  snapshotLive?(): ReturnType<NonNullable<CameraActions['snapshotLive']>>;
}

/** Why live view is unavailable for a camera an admitted observation reports as disabled. */
type LiveAdmissionRefusal = 'disabled' | 'disabled-mid-session';

/** Why a packaged image was served in place of a camera image. */
type SnapshotSubstitution = 'no-acquisition';

/** Everything one attachment supplies to the stable camera delegate, rebound on each reconciliation. */
interface LiveCameraBinding {
  readonly source: CameraMediaSource;
  readonly media: LiveMediaAdapter;
  readonly snapshotMedia?: SnapshotMediaAdapter;
  readonly audioEnabled: boolean;
  readonly snapshotMode: SnapshotMode;
  readonly enablement: () => boolean | undefined;
  readonly reportSession: (outcome: LiveSessionOutcome) => void;
  readonly reportAdmission: (refusal?: LiveAdmissionRefusal) => void;
  readonly reportSnapshot: (substitution?: SnapshotSubstitution) => void;
}

/** Owns HomeKit camera negotiation while delegating source adaptation to the media domain. */
class LiveCameraDelegate implements CameraStreamingDelegate {
  controller?: CameraController;
  private readonly sessions = new Map<string, PendingSession>();
  private readonly prepareGenerations = new Map<string, symbol>();
  private readonly snapshotScope: { identity: object; serial: string };
  private acceptingSessions = true;
  private refused = false;
  private supervision?: ReturnType<typeof setInterval>;

  constructor(
    serial: string,
    private binding: LiveCameraBinding,
    private readonly hap: AdapterAttachmentContext['hap'],
  ) {
    this.snapshotScope = { identity: {}, serial };
  }

  update(binding: LiveCameraBinding): void {
    this.binding = binding;
    this.acceptingSessions = true;
  }

  /**
   * Answers a snapshot request from the camera's own acquisition policy, passing it the admitted enablement
   * observation because a camera that is off is presented rather than photographed. When the policy produces
   * nothing, the packaged unavailable image is served and one bounded reason is latched until a later real
   * image withdraws it, so a camera that only ever shows a placeholder is visible in the log rather than only
   * in the Home app. A disabled camera latches nothing: its image is the intended presentation, and live view
   * already reports why it cannot be watched.
   */
  handleSnapshotRequest(_request: never, callback: (error?: Error, buffer?: Buffer) => void): void {
    const snapshotMedia = this.binding.snapshotMedia;
    if (!snapshotMedia) {
      callback(new Error('camera snapshot adaptation is unavailable'));
      return;
    }
    let substituted = false;
    const enabled = this.binding.enablement();
    void snapshotMedia
      .acquire(this.snapshotScope, this.binding.source, this.binding.snapshotMode, {
        ...(enabled === undefined ? {} : { enabled }),
        onPlaceholder: () => {
          substituted = true;
          this.binding.reportSnapshot('no-acquisition');
        },
      })
      .then(
        (buffer) => {
          if (!substituted) {
            this.binding.reportSnapshot();
          }
          callback(undefined, buffer);
        },
        (error: unknown) => callback(error instanceof Error ? error : new Error('camera snapshot failed')),
      );
  }

  /**
   * Answers `SetupEndpoints` with reservations whose lifetime is the controller's HAP connection. A
   * prepared session holds one UDP port for video, a second when audio is negotiated, and no SDK handle,
   * process, or device session; HomeKit bounds it by that connection rather than by a timer, so a
   * controller that negotiates and then waits keeps a valid answer instead of being invalidated by a
   * plugin deadline.
   *
   * A camera an admitted observation reports as disabled is refused here, which is the only refusal point
   * HAP offers, so no port, handle, or process is opened for it at all.
   */
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    if (this.refuseWhenDisabled('disabled')) {
      callback(new Error('camera is disabled'));
      return;
    }
    const generation = Symbol('camera-stream-prepare');
    this.prepareGenerations.set(request.sessionID, generation);
    void this.prepare(request).then(
      ({ response, session }) => {
        if (!this.acceptingSessions || this.prepareGenerations.get(request.sessionID) !== generation) {
          session.prepared.stop();
          callback(new Error('live media preparation was cancelled'));
          return;
        }
        this.release(request.sessionID);
        this.sessions.set(request.sessionID, session);
        this.admit();
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
    const audioSsrc = this.binding.audioEnabled ? this.hap.CameraController.generateSynchronisationSource() : undefined;
    const prepared = await this.binding.media.prepare({
      addressVersion: request.addressVersion,
      targetAddress: request.targetAddress,
      video: mediaTarget(request.video, this.hap),
      ...(this.binding.audioEnabled ? { audio: mediaTarget(request.audio, this.hap) } : {}),
      onVideoFailure: () => {
        this.controller?.forceStopStreamingSession(request.sessionID);
        this.release(request.sessionID);
      },
      onSessionOutcome: (outcome) => this.binding.reportSession(outcome),
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
    if (request.type === 'stop') {
      this.release(request.sessionID);
      callback();
      return;
    }
    const session = this.sessions.get(request.sessionID);
    if (!session) {
      callback(new Error('live media session was not prepared'));
      return;
    }
    if (request.type === 'reconfigure') {
      if (!session.selection) {
        this.release(request.sessionID);
        callback(new Error('live media session has not started'));
        return;
      }
      const video = negotiatedVideo({ ...session.selection.video, ...request.video }, session.videoSsrc, this.hap);
      session.prepared.reconfigure(video);
      session.selection = { ...session.selection, video: { ...session.selection.video, ...request.video } };
      callback();
      return;
    }
    if (this.refuseWhenDisabled('disabled')) {
      this.release(request.sessionID);
      callback(new Error('camera is disabled'));
      return;
    }
    session.selection = request;
    this.supervise();
    void session.prepared
      .start(this.binding.source, {
        video: negotiatedVideo(request.video, session.videoSsrc, this.hap),
        ...(this.binding.audioEnabled && session.audioSsrc !== undefined
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
        (error: unknown) => {
          this.release(request.sessionID);
          callback(error instanceof Error ? error : new Error('stream failed'));
        },
      );
  }

  stop(): void {
    this.acceptingSessions = false;
    for (const sessionID of [...this.sessions.keys()]) {
      this.release(sessionID);
    }
    this.prepareGenerations.clear();
    this.unsupervise();
  }

  /**
   * Releases the reservations of one recorded session exactly once, whatever ended it. HomeKit ends a
   * session without delivering a stop request when it force-stops one or when a stream request reports an
   * error, so those paths release here too and no ended session is retained. A preparation cancelled
   * before it was recorded releases itself where it completes.
   */
  private release(sessionID: string): void {
    this.prepareGenerations.delete(sessionID);
    const session = this.sessions.get(sessionID);
    this.sessions.delete(sessionID);
    session?.prepared.stop();
    if (this.sessions.size === 0) {
      this.unsupervise();
    }
  }

  /** Reports one refusal when an admitted observation says the camera is disabled. */
  private refuseWhenDisabled(refusal: LiveAdmissionRefusal): boolean {
    if (this.binding.enablement() !== false) {
      return false;
    }
    this.refused = true;
    this.binding.reportAdmission(refusal);
    return true;
  }

  /** Withdraws a latched refusal once a session is admitted again, and only then. */
  private admit(): void {
    if (!this.refused) {
      return;
    }
    this.refused = false;
    this.binding.reportAdmission();
  }

  /**
   * Supervises the sessions of a camera that is streaming. HomeKit is told the session ended, because a
   * force-stop does not reach this delegate, and the same single release path stops adaptation and the SDK
   * consumer rather than letting a disabled camera keep delivering blank frames.
   */
  private supervise(): void {
    if (this.supervision) {
      return;
    }
    this.supervision = setInterval(() => {
      if (!this.refuseWhenDisabled('disabled-mid-session')) {
        return;
      }
      for (const sessionID of [...this.sessions.keys()]) {
        this.controller?.forceStopStreamingSession(sessionID);
        this.release(sessionID);
      }
    }, ENABLEMENT_SUPERVISION_INTERVAL_MS);
    this.supervision.unref?.();
  }

  private unsupervise(): void {
    clearInterval(this.supervision);
    this.supervision = undefined;
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

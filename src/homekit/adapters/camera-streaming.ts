import type { CameraActions } from '@mega-yfue/eufy-sdk';
import type {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  RecordingPacket,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';

import { satisfiesMemberRequirements } from '../../device/member-evidence.js';
import { hasAdmittedMotionEvents, motionSensorService } from './motion.js';
import type {
  AdaptedRecording,
  AdapterAttachmentContext,
  AttachedAdapter,
  HomeKitAdapter,
  HomeKitDefinitions,
  LiveMediaAdapter,
  LiveSessionOutcome,
  NegotiatedLiveVideo,
  NegotiatedRecordedAudio,
  NegotiatedRecording,
  PreparedLiveMedia,
  RecordingMediaAdapter,
  RecordingOutcome,
  SnapshotMediaAdapter,
  SnapshotMode,
} from '../adapter.js';

export const CAMERA_STREAMING_ADAPTER_KEY = 'camera.streaming';

const CAMERA_LIVE_SESSION_CONDITION = 'camera-live-session-failed';
const CAMERA_LIVE_REFUSED_CONDITION = 'camera-live-session-refused';
const CAMERA_SNAPSHOT_UNAVAILABLE_CONDITION = 'camera-snapshot-unavailable';
const CAMERA_RECORDING_UNAVAILABLE_CONDITION = 'camera-recording-unavailable';
const CAMERA_RECORDING_FAILED_CONDITION = 'camera-recording-failed';
const CAMERA_RECORDING_REFUSED_CONDITION = 'camera-recording-refused';

/**
 * The pre-event media window this camera advertises, in milliseconds. HomeKit requires an accessory to
 * advertise at least four seconds, so this is the floor rather than a choice; retaining it is a separate
 * eligibility policy that only an already-warm wired source can satisfy, so a recording adapted here
 * begins at its trigger until that policy exists.
 */
const RECORDING_PREBUFFER_MS = 4_000;

/** The fragment length this camera advertises, which is the value HomeKit Secure Video cameras use. */
const RECORDING_FRAGMENT_LENGTH_MS = 4_000;

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
const CAMERA_RECORD_FRAGMENTS = {
  id: 'camera.recordFragments.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_STREAMING_OWNERS = new WeakMap<object, symbol>();
const CAMERA_STREAMING_STATES = new WeakMap<
  object,
  { owner: symbol; controller: CameraController; delegate: LiveCameraDelegate; recording?: RecordingCameraDelegate }
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
    {
      id: CAMERA_RECORD_FRAGMENTS.id,
      hapFit:
        'Official Camera Recording Management transports negotiated fragmented MP4 recordings over a HomeKit Data Stream, honouring the selected profile, level, geometry, frame rate, bit rate, keyframe cadence, fragment length, AAC-ELD audio, and recording-audio state',
      identityEffect:
        'Recording adds the official recording management, operating mode, and data stream services to the stable camera controller without creating another accessory or service key',
      diagnostics:
        "A camera with no evidenced fragment recording or no recording adaptation is omitted from HomeKit Secure Video with one bounded reason rather than advertising a recording it cannot produce, a reconciliation that withdraws the member refuses later recordings instead of serving them from a withdrawn source, a recording that produces no usable output latches one bounded reason until a later recording produces some, and a camera an admitted observation reports as disabled latches one bounded refusal reason without opening a transport. The advertised pre-event window is HomeKit's own four-second minimum rather than a claim: retaining it requires an eligibility policy this row does not own, so a recording begins at its trigger",
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'advertises the fragmented MP4 container, prebuffer, and motion trigger a recording may select',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'links the motion sensor that triggers a recording to its recording management service',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'shares one motion service with the detection adapter whichever of them attaches first',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'omits HomeKit Secure Video for a camera with no detection event to trigger a recording',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'omits HomeKit Secure Video for a camera with no evidenced fragment recording',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'adapts a recording to exactly the configuration a controller selected',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'records no audio while HomeKit withdraws recording audio',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'records no audio for a camera whose audio the user turned off',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'keeps a running recording on the configuration it started with',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'stops a recording the controller closed without yielding another packet',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'stops a recording whose abort signal fires',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a recording while the admitted enabled observation says the camera is disabled',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'latches one recording failure reason and clears it when a later recording produces output',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'reports the recording state HomeKit persists without holding a source warm for it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a recording after a reconciliation withdraws the camera fragment recording',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a recording stream before any configuration has been selected',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'transcodes source fragments into the negotiated profile, level, geometry, and bit rate',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'fragments the output on forced keyframes no further apart than the selected fragment length',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'codes a keyframe at the selected i-frame interval when it is shorter than a fragment',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'asks for a keyframe one frame before the fragment a boundary can only land on a frame of',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'bounds the recorded frame rate without duplicating frames the source never sent',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'requests source fragments short enough not to delay output behind captured media',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'emits the initialization segment as its own first output unit',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'emits each moof and mdat pair as one fragment and never a box between recordings',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'marks the final fragment last only once the source has ended',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'ends a recording whose adaptation never flushes what the ended source already gave it',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'degrades to a video-only recording when the source carries no audio track',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'records no audio at all when the negotiated recording carries none',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'requests AAC-ELD at the negotiated recording sample rate and channel count',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'stops the source and its adaptation promptly when a recording is cancelled',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'stops the source and its adaptation when its consumer stops iterating',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'extends a source media budget only while the recording is being consumed',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'fails a recording that produces no output within the backstop',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'fails a recording whose adaptation exits before its source ends',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'fails a recording whose source reports an error',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'fails a recording the source exposes no fragment recording for',
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
  const recordingEvidence = context.evidence.has(CAMERA_RECORD_FRAGMENTS.id);
  const recordingAvailable = recordingEvidence && typeof camera.recordFragments === 'function';
  const recordingTrigger = hasAdmittedMotionEvents(context.evidence);
  const recordingConfigured = recordingAvailable && context.recordingMedia !== undefined && recordingTrigger;
  context.diagnose({
    code: CAMERA_RECORDING_UNAVAILABLE_CONDITION,
    capability: 'camera',
    member: 'recordFragments',
    active: !recordingConfigured,
    reason: recordingConfigured
      ? 'recovered'
      : !recordingEvidence
        ? 'missing-evidence'
        : !recordingAvailable
          ? 'missing'
          : context.recordingMedia === undefined
            ? 'adapter-missing'
            : 'missing-trigger',
  });
  const source: CameraMediaSource = {
    live: camera.live.bind(camera),
    ...(storedAvailable ? { snapshotStored: camera.snapshotStored!.bind(camera) } : {}),
    ...(liveAvailable ? { snapshotLive: camera.snapshotLive!.bind(camera) } : {}),
    ...(recordingAvailable ? { recordFragments: camera.recordFragments!.bind(camera) } : {}),
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
  const recordingBinding: RecordingCameraBinding | undefined = recordingConfigured
    ? {
        source,
        media: context.recordingMedia!,
        audioEnabled: context.audioEnabled !== false,
        enablement: binding.enablement,
        reportRecording: recordingReporter(context),
        reportAdmission: cameraRecordingCondition(context, CAMERA_RECORDING_REFUSED_CONDITION),
      }
    : undefined;
  if (existing) {
    existing.owner = owner;
    existing.delegate.update(binding);
    existing.recording?.update(recordingBinding);
    CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
    return attachment(context, existing.controller, existing.delegate, existing.recording, owner);
  }

  const delegate = new LiveCameraDelegate(device.sn, binding, context.hap);
  const recording = recordingConfigured ? new RecordingCameraDelegate(recordingBinding, context.hap) : undefined;
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
      ...(recording
        ? {
            recording: { options: recordingOptions(context), delegate: recording },
            sensors: { motion: motionSensorService(context) },
          }
        : {}),
    },
    true,
  );
  delegate.controller = controller;
  context.accessory.configureController(controller);
  if (recording) {
    recording.recordingManagement = controller.recordingManagement;
  }
  CAMERA_STREAMING_STATES.set(context.accessory, {
    owner,
    controller,
    delegate,
    ...(recording ? { recording } : {}),
  });
  CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
  return attachment(context, controller, delegate, recording, owner);
}

/**
 * What this camera advertises as recordable.
 *
 * The motion trigger is derived from the sensor service the controller is given rather than declared
 * separately, because HomeKit needs the sensor that triggers a recording to be linked to the recording
 * management service, carry its own active state, and follow the camera's HomeKit-active state. Declaring
 * the trigger alone advertises a recording nothing will ever start. That service is resolved through the
 * detection adapter that owns it, so one accessory still carries exactly one motion service whichever of
 * the two attaches first.
 *
 * Doorbell triggers are not declared: HomeKit home hubs do not enable them, so advertising one would claim
 * behaviour no controller will ever exercise.
 *
 * Only the resolutions and rates a recording can actually be coded at are advertised, and only AAC-ELD,
 * so a controller cannot select a contract the adaptation would then have to approximate.
 */
function recordingOptions(context: AdapterAttachmentContext) {
  const { hap } = context;
  return {
    prebufferLength: RECORDING_PREBUFFER_MS,
    mediaContainerConfiguration: {
      type: hap.MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: RECORDING_FRAGMENT_LENGTH_MS,
    },
    video: {
      type: hap.VideoCodecType.H264,
      parameters: {
        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
      },
      resolutions: [
        [1280, 720, 15],
        [1280, 720, 30],
        [1920, 1080, 15],
        [1920, 1080, 30],
      ] as [number, number, number][],
    },
    audio: {
      codecs: [
        {
          type: hap.AudioRecordingCodecType.AAC_ELD,
          audioChannels: 1,
          bitrateMode: hap.AudioBitrate.VARIABLE,
          samplerate: [hap.AudioRecordingSamplerate.KHZ_16, hap.AudioRecordingSamplerate.KHZ_24],
        },
      ],
    },
  };
}

function attachment(
  context: AdapterAttachmentContext,
  controller: CameraController,
  delegate: LiveCameraDelegate,
  recording: RecordingCameraDelegate | undefined,
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
      recording?.stop();
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

function cameraRecordingCondition(context: AdapterAttachmentContext, code: string): (reason?: string) => void {
  return cameraCondition(context, code, 'recordFragments');
}

/**
 * Latches why the most recent recording produced no usable output and clears that condition once a later
 * recording produces some.
 */
function recordingReporter(context: AdapterAttachmentContext): (outcome: RecordingOutcome) => void {
  const condition = cameraRecordingCondition(context, CAMERA_RECORDING_FAILED_CONDITION);
  return (outcome) => condition(outcome.outcome === 'recording' ? undefined : outcome.reason);
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
  recordFragments?(options?: { fragmentSeconds?: number }): ReturnType<NonNullable<CameraActions['recordFragments']>>;
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
  hap: HomeKitDefinitions,
): NegotiatedLiveVideo {
  return {
    width: video.width,
    height: video.height,
    fps: video.fps,
    maxBitRate: video.max_bit_rate,
    profile: h264Profile(video.profile, hap),
    level: h264Level(video.level, hap),
    payloadType: video.pt,
    ssrc,
    mtu: video.mtu,
    rtcpInterval: video.rtcp_interval,
  };
}

function h264Profile(profile: number, hap: HomeKitDefinitions): 'baseline' | 'main' | 'high' {
  return profile === hap.H264Profile.HIGH ? 'high' : profile === hap.H264Profile.MAIN ? 'main' : 'baseline';
}

function h264Level(level: number, hap: HomeKitDefinitions): '3.1' | '3.2' | '4.0' {
  return level === hap.H264Level.LEVEL4_0 ? '4.0' : level === hap.H264Level.LEVEL3_2 ? '3.2' : '3.1';
}

/** Why a recording was refused before any transport was opened. */
type RecordingAdmissionRefusal = 'disabled';

/** Everything one attachment supplies to the stable recording delegate, rebound on each reconciliation. */
interface RecordingCameraBinding {
  readonly source: CameraMediaSource;
  readonly media: RecordingMediaAdapter;
  readonly audioEnabled: boolean;
  readonly enablement: () => boolean | undefined;
  readonly reportRecording: (outcome: RecordingOutcome) => void;
  readonly reportAdmission: (refusal?: RecordingAdmissionRefusal) => void;
}

/**
 * Owns HomeKit Secure Video negotiation while delegating fragment adaptation to the media domain.
 *
 * Nothing is held between recordings. HomeKit persists whether recording is active and which
 * configuration was selected, and this delegate keeps both only so that a recording request can be
 * answered; it never keeps a source warm to build pre-event media, because doing so would spend a battery
 * camera's power on media no eligibility policy has admitted yet.
 */
class RecordingCameraDelegate implements CameraRecordingDelegate {
  recordingManagement?: CameraController['recordingManagement'];
  private configuration?: CameraRecordingConfiguration;
  private readonly streams = new Map<number, AdaptedRecording>();
  private refused = false;

  constructor(
    private binding: RecordingCameraBinding | undefined,
    private readonly hap: HomeKitDefinitions,
  ) {}

  /**
   * Rebinds this delegate to the current attachment, or withdraws it.
   *
   * A reconciliation that no longer admits recording leaves the HomeKit services in place, because a
   * controller's services are fixed when it is configured, so withdrawal is expressed by refusing
   * recordings rather than by continuing to serve them from a source this accessory no longer has. Any
   * recording still running is stopped, since its source went with the binding that opened it.
   */
  update(binding: RecordingCameraBinding | undefined): void {
    this.binding = binding;
    if (!binding) {
      this.stop();
    }
  }

  /**
   * HomeKit's recording-active state needs nothing of this delegate. It exists so a camera can start or
   * stop maintaining pre-event media, and this camera maintains none, so a recording request is answered
   * from a cold source whenever HomeKit makes one.
   */
  updateRecordingActive(): void {}

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
  }

  /**
   * Streams one recording as the units its adaptation produces.
   *
   * The configuration is read once, so a selection HomeKit changes mid-recording applies to the next
   * recording rather than to this one. Cancellation arrives three ways — an aborted signal, a closed
   * stream, or a consumer that stops iterating — and every one of them reaches the same single stop, so
   * the SDK handle and the adaptation are released once however the recording ended.
   */
  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const binding = this.binding;
    const configuration = this.configuration;
    if (!binding || !configuration || !binding.source.recordFragments) {
      throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.INVALID_CONFIGURATION);
    }
    if (binding.enablement() === false) {
      this.refused = true;
      binding.reportAdmission('disabled');
      throw new this.hap.HDSProtocolError(this.hap.HDSProtocolSpecificErrorReason.NOT_ALLOWED);
    }
    if (this.refused) {
      this.refused = false;
      binding.reportAdmission();
    }
    const recording = binding.media.record(binding.source, this.negotiated(binding, configuration), {
      onOutcome: (outcome) => binding.reportRecording(outcome),
    });
    this.streams.set(streamId, recording);
    const abort = (): void => recording.stop();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for await (const fragment of recording) {
        yield { data: fragment.data, isLast: fragment.last };
        if (fragment.last) {
          return;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      recording.stop();
      this.streams.delete(streamId);
    }
  }

  acknowledgeStream(streamId: number): void {
    this.closeRecordingStream(streamId);
  }

  closeRecordingStream(streamId: number): void {
    this.streams.get(streamId)?.stop();
    this.streams.delete(streamId);
  }

  stop(): void {
    for (const streamId of [...this.streams.keys()]) {
      this.closeRecordingStream(streamId);
    }
  }

  /**
   * Translates one selected HomeKit recording configuration into the media domain's vocabulary.
   *
   * Audio is withheld whenever HomeKit's own recording-audio state is off, whenever the user turned this
   * camera's audio off, and whenever a controller selected a codec this camera never advertised, because
   * a recording with no audio track is the truthful answer in all three cases and a substituted codec
   * would not be.
   */
  private negotiated(
    binding: RecordingCameraBinding,
    configuration: CameraRecordingConfiguration,
  ): NegotiatedRecording {
    const [width, height, fps] = configuration.videoCodec.resolution;
    const audio = this.recordedAudio(binding, configuration);
    return {
      width,
      height,
      fps,
      maxBitRate: configuration.videoCodec.parameters.bitRate,
      profile: h264Profile(configuration.videoCodec.parameters.profile, this.hap),
      level: h264Level(configuration.videoCodec.parameters.level, this.hap),
      iFrameIntervalMs: configuration.videoCodec.parameters.iFrameInterval,
      fragmentLengthMs: configuration.mediaContainerConfiguration.fragmentLength,
      ...(audio ? { audio } : {}),
    };
  }

  private recordedAudio(
    binding: RecordingCameraBinding,
    configuration: CameraRecordingConfiguration,
  ): NegotiatedRecordedAudio | undefined {
    if (!binding.audioEnabled || !this.recordingAudioActive()) {
      return undefined;
    }
    if (configuration.audioCodec.type !== this.hap.AudioRecordingCodecType.AAC_ELD) {
      return undefined;
    }
    return {
      codec: 'AAC-eld',
      channels: configuration.audioCodec.audioChannels ?? 1,
      sampleRate: configuration.audioCodec.samplerate === this.hap.AudioRecordingSamplerate.KHZ_24 ? 24 : 16,
      maxBitRate: configuration.audioCodec.bitrate,
    };
  }

  /**
   * Whether HomeKit currently wants recorded audio. The characteristic lives on the recording management
   * service rather than the operating mode service, and an accessory starts with it off, so a recording
   * carries no audio until a controller asks for it.
   */
  private recordingAudioActive(): boolean {
    const service = this.recordingManagement?.recordingManagementService;
    if (!service) {
      return false;
    }
    return Boolean(service.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value);
  }
}

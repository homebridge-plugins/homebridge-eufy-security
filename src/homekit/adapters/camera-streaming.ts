import type { AnyDeviceEvent, CameraActions } from '@mega-yfue/eufy-sdk';
import { NightVision, unreflectedMembers } from '@mega-yfue/eufy-sdk';
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
import {
  ENABLEMENT_EVENT_TRACE,
  deviceOperationIssuer,
  enablementAnnouncement,
  INVALID_OBSERVATION_CONDITION,
  observationReader,
  type DeviceOperationIssuer,
  type DeviceOperationState,
} from '../device-control.js';
import type {
  AdaptedRecording,
  LiveMediaAdapter,
  LiveMediaSource,
  LiveSessionOutcome,
  MediaSessionBudget,
  MediaSessionClaim,
  NegotiatedLiveVideo,
  NegotiatedRecordedAudio,
  NegotiatedRecording,
  PreparedLiveMedia,
  RecordingMediaAdapter,
  RecordingMediaSource,
  RecordingOutcome,
  SnapshotAcquisitionScope,
  SnapshotFailure,
  SnapshotMediaAdapter,
  SnapshotMediaSource,
  SnapshotMode,
  TalkbackOutcome,
} from '../../media/contracts.js';
import { isBatteryPowered } from './battery.js';
import { hasAdmittedDoorbellPress } from './doorbell.js';
import { hasAdmittedMotionEvents, motionSensorService } from './motion.js';
import type {
  AdapterAttachmentContext,
  AdapterDetachmentReason,
  AdapterEventTrace,
  AttachedAdapter,
  HomeKitAdapter,
  HomeKitDefinitions,
} from '../adapter.js';

export const CAMERA_STREAMING_ADAPTER_KEY = 'camera.streaming';

/**
 * The resolutions advertised to a controller when the camera's own shape is not known.
 *
 * 16:9, because it is what most cameras produce and what a controller's tile is drawn at. A camera whose
 * shape has never been observed keeps these rather than being given a guessed matrix.
 */
export const DEFAULT_ADVERTISED_RESOLUTIONS: readonly (readonly [number, number, number])[] = [
  [320, 180, 15],
  [640, 360, 30],
  [1280, 720, 30],
  [1920, 1080, 30],
];

/** The frame rate every derived entry is advertised at; a negotiated rate is a ceiling, not a target. */
const ADVERTISED_FPS = 30;

/**
 * Divisors of the native size a derived matrix offers, so a controller drawing a small tile is not forced to
 * the largest.
 *
 * Whole divisions of the camera's own geometry rather than a list of heights: a fixed list carries steps
 * belonging to other shapes, which land on sizes no camera produces — a 16:9 camera offered a 1200-high step
 * advertises 2134x1200, whose ratio has drifted and whose width is arbitrary. Halving keeps the exact aspect
 * and stays even, and on a 16:9 camera it lands on the familiar ladder unchanged.
 */
const ADVERTISED_DIVISORS = [1, 2, 4] as const;

/** Below this the shape is not a camera frame, and deriving a matrix from it would publish nonsense. */
const SMALLEST_CREDIBLE_DIMENSION = 120;

/**
 * The resolutions one camera advertises, derived from the geometry it actually produces.
 *
 * A controller picks one entry and the plugin must then deliver exactly that geometry, so a matrix carrying
 * only one shape forces every camera into it. Every entry used to be 16:9, which fitted a 4:3 camera inside a
 * 16:9 frame: measured on a 1600x1200 doorbell negotiated at 1280x720, the picture occupies 960x720 with 160
 * black columns each side — a quarter of every encoded frame is black, and that quarter is charged against
 * the negotiated bit rate rather than spent on the picture.
 *
 * Entries keep the camera's own aspect and never exceed its own size, because asking a controller to accept
 * more pixels than the camera codes spends bit rate on upscaling. Dimensions are rounded to even numbers,
 * which is all H.264 can code. A shape that is absent or not credible falls back to
 * {@link DEFAULT_ADVERTISED_RESOLUTIONS}: a guessed shape is worse than a fitted one, because the fitting
 * would still happen and at the wrong ratio.
 *
 * REACHES A CONTROLLER ONLY AT PAIRING. HAP's configuration number is derived from the accessory's structure
 * with every characteristic value replaced by null, so changing what this returns never tells a paired
 * controller to read it again — verified in the host's own implementation, which carries a TODO admitting the
 * omission. A controller therefore keeps whatever matrix it read when the accessory's structure last changed
 * and may go on selecting a geometry from it that this no longer offers, which is honoured and fitted as
 * before. Measured on a paired 4:3 doorbell: the matrix below was published and the controller still selected
 * 1280x720. So this improves an accessory paired AFTER its shape is known, and nothing before that.
 */
export function advertisedResolutions(
  geometry: { readonly width: number; readonly height: number } | undefined,
): readonly (readonly [number, number, number])[] {
  if (
    !geometry ||
    !Number.isSafeInteger(geometry.width) ||
    !Number.isSafeInteger(geometry.height) ||
    geometry.width < SMALLEST_CREDIBLE_DIMENSION ||
    geometry.height < SMALLEST_CREDIBLE_DIMENSION
  ) {
    return DEFAULT_ADVERTISED_RESOLUTIONS;
  }
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  const derived = new Map<string, readonly [number, number, number]>();
  for (const divisor of ADVERTISED_DIVISORS) {
    const width = even(geometry.width / divisor);
    const height = even(geometry.height / divisor);
    if (width < SMALLEST_CREDIBLE_DIMENSION && height < SMALLEST_CREDIBLE_DIMENSION) {
      continue;
    }
    derived.set(`${width}x${height}`, [width, height, ADVERTISED_FPS]);
  }
  return [...derived.values()].sort(([leftWidth], [rightWidth]) => leftWidth - rightWidth);
}

/**
 * The stable key of the Camera Operating Mode service this bundle publishes for a camera that configures no
 * HomeKit Secure Video recording, and therefore has no controller-owned service to carry the presented
 * state.
 */
export const CAMERA_OPERATING_MODE_SERVICE_KEY = 'camera.operating-mode';

const CAMERA_LIVE_SESSION_CONDITION = 'camera-live-session-failed';
const CAMERA_LIVE_REFUSED_CONDITION = 'camera-live-session-refused';
/**
 * Why live view is unavailable for a camera the host has no room for, kept apart from the enablement refusal.
 *
 * The two cannot share a condition. They are withdrawn by different events, they name different things to do
 * about them — one is a camera to switch on, the other a ceiling to raise or a viewer to close — and a camera
 * cannot have two writers for why live view is unavailable, so a transient capacity refusal would otherwise
 * clear the latch a disabled camera is holding.
 */
const CAMERA_MEDIA_AT_CAPACITY_CONDITION = 'camera-media-at-capacity';
const CAMERA_SNAPSHOT_UNAVAILABLE_CONDITION = 'camera-snapshot-unavailable';
const CAMERA_RECORDING_UNAVAILABLE_CONDITION = 'camera-recording-unavailable';
const CAMERA_RECORDING_FAILED_CONDITION = 'camera-recording-failed';
const CAMERA_RECORDING_REFUSED_CONDITION = 'camera-recording-refused';
const CAMERA_TALKBACK_UNAVAILABLE_CONDITION = 'camera-talkback-capability-unavailable';
const CAMERA_TALKBACK_FAILED_CONDITION = 'camera-talkback-failed';

/**
 * The pre-event media window this camera advertises and, when it is eligible, retains in milliseconds.
 * HomeKit requires an accessory to advertise at least four seconds, so this is the floor rather than a
 * choice, and a camera that retains it never retains more than a controller can select.
 */
const RECORDING_PREBUFFER_MS = 4_000;

/** The fragment length this camera advertises, which is the value HomeKit Secure Video cameras use. */
const RECORDING_FRAGMENT_LENGTH_MS = 4_000;

/**
 * The recorded audio sample rates this camera advertises, in kHz.
 *
 * A station sends 16 kHz mono, so every higher rate is resampled on the way out rather than being source
 * truth. They are still advertised because the adaptation genuinely produces each of them, and a controller
 * that finds no rate it accepts selects no recording configuration at all.
 */
const RECORDING_AUDIO_SAMPLE_RATES = [16, 24, 32, 48] as const;

/** The HomeKit identifier for each advertised recorded audio sample rate. */
const RECORDING_SAMPLE_RATES = (
  hap: HomeKitDefinitions,
): Record<(typeof RECORDING_AUDIO_SAMPLE_RATES)[number], number> => ({
  16: hap.AudioRecordingSamplerate.KHZ_16,
  24: hap.AudioRecordingSamplerate.KHZ_24,
  32: hap.AudioRecordingSamplerate.KHZ_32,
  48: hap.AudioRecordingSamplerate.KHZ_48,
});

/**
 * The exact enablement observation a live session is admitted against. The row itself belongs to the
 * camera controls bundle; this bundle only consumes it, and only when the manifest reports it as a
 * boolean read, because no other member shape carries that meaning.
 */
const CAMERA_ENABLED_READ = { id: 'camera.enabled.read', kind: 'read', type: 'bool' } as const;

/**
 * The indicator LED this bundle presents on the same service, and the operation that moves it. HomeKit
 * calls it the camera operating mode indicator, which is what the Home app shows as the camera's status
 * light, so it belongs on that service rather than on a switch of its own.
 */
const CAMERA_STATUS_LED_READ = { id: 'camera.statusLed.read', kind: 'read', type: 'bool', writable: true } as const;
const CAMERA_STATUS_LED_WRITE = { id: 'camera.statusLed.persistent-operation', kind: 'persistent-operation' } as const;

/**
 * Night vision, presented on the same service. The SDK reports it as a three-value mode and HomeKit carries
 * one boolean, so the projection is this plugin's: see {@link nightVisionPresentation}.
 */
const CAMERA_NIGHT_VISION_READ = { id: 'camera.nightVision.read', kind: 'read', type: 'enum', writable: true } as const;
const CAMERA_NIGHT_VISION_WRITE = {
  id: 'camera.nightVision.persistent-operation',
  kind: 'persistent-operation',
} as const;

/** The operation that turns this camera off and on again, which HomeKit's own camera-active state drives. */
const CAMERA_ENABLED_WRITE = { id: 'camera.enabled.persistent-operation', kind: 'persistent-operation' } as const;

/** The night-vision modes the SDK declares, which are the only readings this plugin will project. */
const NIGHT_VISION_MODES: ReadonlySet<number> = new Set(Object.values(NightVision));

/**
 * The SDK event names that say this camera's enablement moved: the push one a write of this plugin's own
 * confirmed, and the poll one a change made anywhere else produced. Neither carries the authority — the
 * observation is re-read, because that is the value every other decision here is made on.
 */

/**
 * How often an active live session re-reads the enablement observation.
 *
 * The SDK announces an enablement change, and a session ends on that announcement rather than on this tick,
 * so this is the backstop for a change no announcement reached: the push event covers only a write the SDK
 * itself issued, and the poll event only fires as often as the account is polled. The read is an in-memory
 * one whose own staleness policy bounds how often it reaches the network, so the tick period buys detection
 * latency without buying requests.
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
const CAMERA_TALKBACK = {
  id: 'camera.talkback.momentary-action',
  kind: 'momentary-action',
} as const;
const CAMERA_STREAMING_OWNERS = new WeakMap<object, symbol>();
const CAMERA_STREAMING_STATES = new WeakMap<
  object,
  {
    owner: symbol;
    controller: CameraController;
    delegate: LiveCameraDelegate;
    recording?: RecordingCameraDelegate;
    operations: DeviceOperationState;
    audio: boolean;
    talkback: boolean;
  }
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
        'Missing typed live media or adaptation fails closed without a raw-stream fallback, a session that ends without usable video latches one bounded reason until a later session streams, and a camera an admitted observation reports as disabled latches one bounded refusal reason without opening a transport, including a session such a camera answered with audio and never a video frame, which is named as the camera being off rather than as a transport failure. A live session may be the call that opens the shared source, so it opens it with the pre-event window this camera retains for recordings and with none at all when it retains none, rather than leaving a recording to ask for a window the source it joined was never given',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'advertises exactly the profile, level, and resolution matrix a live run may select',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'opens a mains-powered camera source with the pre-event window a recording drains',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'retains no pre-event media for a camera with no recording to drain it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'drives negotiated prepare, start, reconfigure, and stop through the media seam',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'traces the identity-free video selection a controller starts and reconfigures',
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
          behavior:
            'reports a disabled camera that answered a session with no video as switched off, not as a transport failure',
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
      id: CAMERA_TALKBACK.id,
      hapFit:
        'Official camera return audio is decoded from the negotiated HomeKit AAC-ELD SRTP endpoint and adapted to the SDK speaker input only while that controller session consumes it',
      identityEffect:
        'Talkback enriches the existing stable camera controller and its speaker service without creating another accessory',
      diagnostics:
        'Exact SDK action evidence and enabled camera audio are required; return-audio adaptation and device-audio failures release only the talkback resources, latch one bounded reason, and leave outbound video and audio running',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'admits one 16 kHz return-audio source only from exact talkback evidence and a bound SDK action',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'does not infer talkback from an SDK action without its exact evidence',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'does not admit talkback when camera audio is disabled',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'opens battery or solar talkback without a pre-event window',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'rebuilds the camera controller when reconciliation changes its audio or talkback advertisement',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'transcodes HomeKit return audio to 16 kHz mono AAC-LC ADTS before opening one SDK handle',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'extends a source budget only while HomeKit return audio is being consumed',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'cleans a device-audio failure without stopping outbound video or audio',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'reports an SDK-stopped talkback path while outbound media continues',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'reports return-audio adaptation failure without coupling it to outbound media',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'stops a talkback handle that resolves after HomeKit cancelled the session',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'finishes whole-session cleanup when the SDK handle throws synchronously on stop',
        },
        {
          file: 'test/contracts/live-media.test.ts',
          behavior: 'does not report recovery when the SDK rejects the first return-audio write synchronously',
        },
      ],
    },
    {
      id: CAMERA_SNAPSHOT_STORED.id,
      hapFit:
        'Official camera snapshot requests consume only the passive stored SDK image in Cloud mode and when Refresh has no retained image, and consume nothing at all while an admitted observation reports the camera disabled',
      identityEffect: 'Stored snapshots use the stable camera controller without creating another service',
      diagnostics:
        "Cloud never calls live acquisition; retained real imagery precedes typed offline presentation, while a request with neither serves the packaged unavailable image and latches one bounded reason naming the acquisition that left it unanswered, and the SDK's own refusal reason where it gave one, until a later real or intentional presentation withdraws it",
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
          behavior: 'attributes an unanswered snapshot to the acquisition its selected mode requires',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'attributes an unanswered snapshot to the typed reason the SDK acquisition reports',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'attributes a refused snapshot request to the snapshot adaptation it never had',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'attributes an unanswered Refresh snapshot to the stored acquisition that failed',
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
          behavior: 'presents typed offline only when no retained real image exists',
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
        "Live never calls stored acquisition and Refresh reports missing live acquisition only when stored acquisition is also unavailable; failed acquisition preserves the last successful real image before selecting a typed placeholder, and a live refresh that fails while nothing is retained is reported with the SDK's own reason as the acquisition that left the camera without an image",
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
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'attributes an unanswered snapshot to the typed reason the SDK acquisition reports',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior:
            'attributes an intermittent Refresh camera to the live refresh that failed while nothing is retained',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'keeps a retained image authoritative when a background live refresh fails',
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
        'Official Camera Recording Management transports negotiated fragmented MP4 recordings over a HomeKit Data Stream, honouring the selected profile, level, geometry, frame rate, bit rate, keyframe cadence, fragment length, recorded audio profile and sample rate, and recording-audio state',
      identityEffect:
        'Recording adds the official recording management, operating mode, and data stream services to the stable camera controller without creating another accessory or service key',
      diagnostics:
        "A camera with no evidenced fragment recording or no recording adaptation is omitted from HomeKit Secure Video with one bounded reason rather than advertising a recording it cannot produce, a reconciliation that withdraws the member refuses later recordings instead of serving them from a withdrawn source, a recording that produces no usable output latches one bounded reason until a later recording produces some, and a camera an admitted observation reports as disabled latches one bounded refusal reason without opening a transport. The advertised pre-event window is HomeKit's own four-second minimum, retained only by a mains-powered camera and only on a source something else already opened, so a battery or solar camera and an unwatched camera alike begin at the trigger",
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
          behavior: 'advertises a press as a recording trigger for a camera whose doorbell press is admitted',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'advertises both triggers for a doorbell that also reports motion',
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
          behavior: 'advertises both recorded audio profiles and every sample rate it can produce',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'records the audio profile and sample rate a controller selected',
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
          behavior: 'opens a mains-powered camera source with the pre-event window a recording drains',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'opens a mains-powered live snapshot with the same pre-event window as live view',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'never retains pre-event media for a battery or solar camera',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'opens a battery or solar live snapshot without a pre-event window',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'retains no pre-event media for a camera with no recording to drain it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'asks for no more pre-event media than the window the camera retains',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'asks for only the shorter pre-event window a controller selected',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'drains the pre-event media window the negotiated recording carries',
        },
        {
          file: 'test/contracts/recording-media.test.ts',
          behavior: 'asks for no pre-event media at all for a recording that carries no window',
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
          behavior: 'codes the recorded audio profile and sample rate the controller selected',
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
    {
      id: CAMERA_STATUS_LED_READ.id,
      hapFit:
        "Camera Operating Mode Indicator carries the camera's own status-light state, which is what the Home app presents as its status light",
      identityEffect:
        'The indicator shares the one operating mode service this camera presents on, so no separate switch service is published for it',
      diagnostics:
        'A reading that is absent, not a boolean, or faulting answers HomeKit with no response rather than a borrowed value, and a camera that offers the setter without reporting the state publishes no indicator at all',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'presents the indicator LED on the operating mode service and moves it through the typed operation',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'presents no indicator LED without exact evidence and a bound typed operation',
        },
        {
          file: 'test/contracts/camera-controls-adapter.test.ts',
          behavior: 'withdraws the indicator LED switch an earlier version published for this camera',
        },
      ],
    },
    {
      id: CAMERA_STATUS_LED_WRITE.id,
      hapFit: 'A HomeKit write moves the indicator LED through the typed SDK operation and nothing else',
      identityEffect: 'The operation is issued on the operating mode service the camera already presents on',
      diagnostics:
        'One write is in flight per member at a time, a write is bounded before HomeKit is answered, an operation the camera reports unsupported is latched and asked once, and the characteristic is restored from the authoritative reading rather than from what was asked for',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'presents the indicator LED on the operating mode service and moves it through the typed operation',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'blocks later indicator writes once the camera reports the operation unsupported',
        },
      ],
    },
    {
      id: CAMERA_NIGHT_VISION_READ.id,
      hapFit:
        "Night Vision carries the one boolean HomeKit has for it, projected from the camera's own three-mode reading, where every mode but off reads as on",
      identityEffect: 'Night vision shares the one operating mode service this camera presents on',
      diagnostics:
        'A mode that is absent, of another shape, or faulting answers HomeKit with no response, and a camera that offers the setter without reporting a mode presents no night vision at all',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'restores the night-vision mode the camera reported rather than one chosen for it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'presents no night vision without exact evidence and a bound typed operation',
        },
      ],
    },
    {
      id: CAMERA_NIGHT_VISION_WRITE.id,
      hapFit:
        'Turning night vision on restores the mode this camera last reported for itself, because HomeKit carries no mode of its own to state',
      identityEffect: 'The operation is issued on the operating mode service the camera already presents on',
      diagnostics:
        'Full colour is not offered by every model, so a camera whose lit mode was never observed is turned on to infrared rather than to a mode it may refuse, and the characteristic is restored from the authoritative reading',
      verification: [
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'restores the night-vision mode the camera reported rather than one chosen for it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'turns night vision on to infrared for a camera whose lit mode was never observed',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'restores a night-vision mode observed before a reconciliation replaced the attachment',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'refuses a night-vision mode the SDK does not declare instead of reading it as night vision',
        },
      ],
    },
    {
      id: CAMERA_ENABLED_WRITE.id,
      hapFit:
        "HomeKit's own camera-active state is carried through to the camera's power, so a camera the user set to off for this mode is off rather than merely unwatched, and the camera controls bundle writes the same member from its Camera Enabled switch, which stays reachable when Apple Home declines to write a disabled camera's operating mode",
      identityEffect: 'The operation is issued on the operating mode service the camera already presents on',
      diagnostics:
        'The camera is written only where a controller wrote the state and the camera disagrees with it, so a state HAP restored cannot reach the device while a value HomeKit re-asserts does, which is what reconciles a camera after a restart; a camera whose power cannot be written still accepts the HomeKit state, and a camera that refuses the change reverts it',
      verification: [
        {
          file: 'test/contracts/camera-controls-adapter.test.ts',
          behavior: 'switches the camera off and on again when HomeKit writes the enabled state',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'turns the camera off and on again when HomeKit writes its own camera-active state',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'accepts a HomeKit camera-active state it cannot carry to the camera without pretending to',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'reverts the HomeKit camera-active state when the camera refuses the change',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'keeps the HomeKit camera-active state a camera has accepted but not yet converged on',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'writes the camera only for a controller write, never for a state HAP restored',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'carries a camera-active state HomeKit re-asserts to a camera that disagrees with it',
        },
        {
          file: 'test/contracts/camera-streaming-adapter.test.ts',
          behavior: 'ignores a camera-active write the camera already agrees with',
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
  const recordingMotion = hasAdmittedMotionEvents(context.evidence);
  const recordingPress = hasAdmittedDoorbellPress(context.evidence);
  const recordingConfigured =
    recordingAvailable && context.recordingMedia !== undefined && (recordingMotion || recordingPress);
  const talkbackEvidence = context.evidence.has(CAMERA_TALKBACK.id);
  const talkbackConfigured =
    talkbackEvidence && typeof camera.talkback === 'function' && context.audioEnabled !== false;
  context.diagnose({
    code: CAMERA_TALKBACK_UNAVAILABLE_CONDITION,
    capability: 'camera',
    member: 'talkback',
    active: context.audioEnabled !== false && talkbackEvidence && !talkbackConfigured,
    reason: context.audioEnabled !== false && talkbackEvidence && !talkbackConfigured ? 'missing' : 'recovered',
  });
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
  const prebufferLengthMs = recordingConfigured ? retainedPrebufferMs(context.evidence) : 0;
  const liveSourceOptions = prebufferLengthMs > 0 ? { preBufferSeconds: prebufferLengthMs / 1_000 } : undefined;
  const openLiveSource = camera.live.bind(camera);
  const observed = observesEnablement(context, camera);
  const enablement = enablementObservation(camera, observed);
  const detachRejectors = new Set<(error: unknown) => void>();
  let detached = false;
  const readBoolean = observationReader(context, 'boolean');
  const readNumber = observationReader(context, 'number');
  const reportAdmission = cameraLiveCondition(context, CAMERA_LIVE_REFUSED_CONDITION);
  const reportCapacity = cameraLiveCondition(context, CAMERA_MEDIA_AT_CAPACITY_CONDITION);
  const acquireLiveSnapshot = liveAvailable ? camera.snapshotLive!.bind(camera) : undefined;
  const openTalkback = talkbackConfigured ? camera.talkback!.bind(camera) : undefined;
  const source: CameraMediaSource = {
    live: () => openLiveSource(liveSourceOptions),
    ...(storedAvailable ? { snapshotStored: camera.snapshotStored!.bind(camera) } : {}),
    ...(acquireLiveSnapshot ? { snapshotLive: () => acquireLiveSnapshot(liveSourceOptions) } : {}),
    ...(recordingAvailable ? { recordFragments: camera.recordFragments!.bind(camera) } : {}),
    ...(openTalkback ? { talkback: () => openTalkback(liveSourceOptions) } : {}),
  };
  const existing = CAMERA_STREAMING_STATES.get(context.accessory);
  const owner = Symbol('camera-streaming-owner');
  const operations: DeviceOperationState = existing?.operations ?? {
    owner,
    activeOperations: new Map(),
    blockedOperations: new Set(),
  };
  operations.owner = owner;
  const issue = deviceOperationIssuer({
    context,
    state: operations,
    owned: () => CAMERA_STREAMING_OWNERS.get(context.accessory) === owner,
    detached: () => detached,
    detachRejectors,
  });
  /** Everything the operating mode service presents and operates, resolved once per attachment. */
  const controls = { camera, enablement, observed, issue, readBoolean, readNumber } as const;
  /** Wakes every write still in flight when this attachment stops being the one HomeKit is talking to. */
  const releaseOperations = (): void => {
    detached = true;
    const error = new context.hap.HapStatusError(context.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    for (const reject of detachRejectors) {
      reject(error);
    }
    detachRejectors.clear();
  };
  const binding: LiveCameraBinding = {
    source,
    media: context.liveMedia,
    ...(context.snapshotMedia ? { snapshotMedia: context.snapshotMedia } : {}),
    audioEnabled: context.audioEnabled !== false,
    snapshotMode,
    enablement,
    availability: availabilityObservation(context.device.sn, context.availability),
    reportSession: liveSessionReporter(context, reportAdmission),
    reportRelease: () => context.trace?.({ event: 'live-session-released' }),
    reportTalkback: talkbackReporter(context),
    reportAdmission,
    reportCapacity,
    ...(context.mediaBudget ? { budget: context.mediaBudget } : {}),
    reportSnapshot: cameraCondition(context, CAMERA_SNAPSHOT_UNAVAILABLE_CONDITION, 'snapshot'),
    reportSelection: context.trace,
  };
  const recordingBinding: RecordingCameraBinding | undefined = recordingConfigured
    ? {
        source,
        media: context.recordingMedia!,
        audioEnabled: context.audioEnabled !== false,
        prebufferLengthMs,
        enablement: binding.enablement,
        reportRecording: recordingReporter(context),
        reportAdmission: cameraRecordingCondition(context, CAMERA_RECORDING_REFUSED_CONDITION),
      }
    : undefined;
  if (existing && existing.audio === binding.audioEnabled && existing.talkback === talkbackConfigured) {
    existing.owner = owner;
    existing.operations = operations;
    existing.delegate.update(binding);
    existing.recording?.update(recordingBinding);
    CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
    return attachment(
      context,
      existing.controller,
      existing.delegate,
      existing.recording,
      owner,
      controls,
      releaseOperations,
    );
  }
  if (existing) {
    existing.delegate.stop();
    existing.recording?.stop();
    context.accessory.removeController(existing.controller);
    if (!talkbackConfigured) {
      context.observed(CAMERA_TALKBACK_FAILED_CONDITION);
    }
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
          resolutions: advertisedResolutions(context.sourceGeometry).map(
            (entry) => [...entry] as [number, number, number],
          ),
        },
        ...(context.audioEnabled === false
          ? {}
          : {
              audio: {
                twoWayAudio: talkbackConfigured,
                codecs: [
                  {
                    type: context.hap.AudioStreamingCodecType.AAC_ELD,
                    audioChannels: 1,
                    bitrate: 0,
                    samplerate: talkbackConfigured
                      ? [context.hap.AudioStreamingSamplerate.KHZ_16]
                      : [context.hap.AudioStreamingSamplerate.KHZ_16, context.hap.AudioStreamingSamplerate.KHZ_24],
                  },
                ],
              },
            }),
      },
      ...(recording
        ? {
            recording: { options: recordingOptions(context, recordingPress), delegate: recording },
            ...(recordingMotion ? { sensors: { motion: motionSensorService(context) } } : {}),
          }
        : {}),
    },
    true,
  );
  delegate.controller = controller;
  if (recording) {
    removeOperatingMode(context);
  }
  context.accessory.configureController(controller);
  if (recording) {
    recording.recordingManagement = controller.recordingManagement;
  }
  CAMERA_STREAMING_STATES.set(context.accessory, {
    owner,
    controller,
    delegate,
    operations,
    audio: binding.audioEnabled,
    talkback: talkbackConfigured,
    ...(recording ? { recording } : {}),
  });
  CAMERA_STREAMING_OWNERS.set(context.accessory, owner);
  return attachment(context, controller, delegate, recording, owner, controls, releaseOperations);
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
 * A press trigger is declared rather than derived, and that asymmetry with motion is deliberate. HomeKit
 * links nothing for a press and mirrors no state onto the doorbell service, so the advertised trigger is the
 * whole mechanism; the service carrying the press stays wholly owned by the doorbell adapter. Deriving it
 * instead would mean building the doorbell controller, which cannot be told to leave the microphone and
 * speaker services alone and would put a second one of each on an accessory that already has them.
 *
 * Whether a home hub enables a press trigger is the hub's decision to publish in the configuration it
 * selects, so it is advertised wherever a press exists rather than asserted here.
 *
 * Only the resolutions and rates a recording can actually be coded at are advertised, and only AAC-ELD,
 * so a controller cannot select a contract the adaptation would then have to approximate.
 */
function recordingOptions(context: AdapterAttachmentContext, press: boolean) {
  const { hap } = context;
  return {
    prebufferLength: RECORDING_PREBUFFER_MS,
    ...(press ? { overrideEventTriggerOptions: [hap.EventTriggerOption.DOORBELL] } : {}),
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
      codecs: [hap.AudioRecordingCodecType.AAC_LC, hap.AudioRecordingCodecType.AAC_ELD].map((type) => ({
        type,
        audioChannels: 1,
        bitrateMode: hap.AudioBitrate.VARIABLE,
        samplerate: RECORDING_AUDIO_SAMPLE_RATES.map((rate) => RECORDING_SAMPLE_RATES(hap)[rate]),
      })),
    },
  };
}

/**
 * How much pre-event media a camera admitted to HomeKit Secure Video retains on its shared source, in
 * milliseconds. A camera with no recording to serve retains none, because a window nothing can drain is
 * only memory.
 *
 * Only a mains-powered camera retains any. The window is a rolling buffer of media the source was already
 * carrying, and it is configured on the source rather than kept warm for it, so a camera nobody is watching
 * still answers a recording from its trigger: nothing here opens a stream to fill a buffer. A battery or
 * solar camera is withheld from it entirely, because the only way its buffer would ever hold anything is a
 * stream held open on its own power.
 *
 * The window belongs to whichever consumer opens the shared source, so live view asks for the same one a
 * recording drains: measured on a wired camera, a source opened with the window handed a recording media it
 * had captured before the recording attached, and the same window asked for only at recording time on a
 * source opened without it delivered none. Live snapshots ask for the same window because they can also be
 * the call that opens the source; no source-creating path may silently decide that later recordings retain
 * nothing.
 */
function retainedPrebufferMs(evidence: AdapterAttachmentContext['evidence']): number {
  return isBatteryPowered(evidence) ? 0 : RECORDING_PREBUFFER_MS;
}

function attachment(
  context: AdapterAttachmentContext,
  controller: CameraController,
  delegate: LiveCameraDelegate,
  recording: RecordingCameraDelegate | undefined,
  owner: symbol,
  controls: OperatingModeControls,
  releaseOperations: () => void,
): AttachedAdapter {
  const presentation = operatingModePresentation(context, controller, controls);
  return {
    /**
     * Follows an announced enablement change: a session watching a camera which just went off is ended at
     * once rather than at the next supervision read, and the trace states whether the reading behind that
     * decision answered.
     */
    event(event: AnyDeviceEvent): AdapterEventTrace | undefined {
      const trace = enablementAnnouncement(context, event, presentation.observe);
      if (trace === undefined) {
        return undefined;
      }
      delegate.observeEnablement();
      return trace;
    },
    detach(reason?: AdapterDetachmentReason): void {
      if (CAMERA_STREAMING_OWNERS.get(context.accessory) !== owner) {
        return;
      }
      delegate.stop();
      recording?.stop();
      releaseOperations();
      if (reason === 'shutdown') {
        return;
      }
      CAMERA_STREAMING_OWNERS.delete(context.accessory);
      CAMERA_STREAMING_STATES.delete(context.accessory);
      context.accessory.removeController(controller);
      presentation.remove();
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
 *
 * A session a camera answered with audio and never a video frame is reported as that camera being switched
 * off, not as a transport failure, when its admitted observation says it is off: measured on a real camera
 * that had been turned off, the source accepted the start, delivered audio for the whole warm-up window and
 * reported the SDK's `audio-only` stage, which is the corroboration where a reading taken before the
 * session could have been stale. The caller decides that, because it holds the latch which decides whether
 * the same refusal has already been reported; the enablement refusal condition itself is the one the admission
 * gate reports through, so that condition cannot have two writers. A refusal for host capacity is a separate
 * condition with a writer of its own, because the two are withdrawn by different events.
 */
function liveSessionReporter(
  context: AdapterAttachmentContext,
  refusal: (reason?: LiveAdmissionRefusal) => void,
): (outcome: LiveSessionOutcome, switchedOff?: boolean) => void {
  const condition = cameraLiveCondition(context, CAMERA_LIVE_SESSION_CONDITION);
  return (outcome, switchedOff) => {
    if (outcome.outcome === 'streaming') {
      condition();
      return;
    }
    context.trace?.({ event: 'live-session-failed', ...outcome });
    if (switchedOff) {
      refusal('disabled-no-video' satisfies LiveAdmissionRefusal);
      return;
    }
    condition(outcome.reason);
  };
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

/** Latches an isolated return-audio failure and clears it when later talkback starts producing audio. */
function talkbackReporter(context: AdapterAttachmentContext): (outcome: TalkbackOutcome) => void {
  const condition = cameraCondition(context, CAMERA_TALKBACK_FAILED_CONDITION, 'talkback');
  return (outcome) => condition(outcome.outcome === 'talking' ? undefined : outcome.reason);
}

/**
 * Whether this camera has an enablement observation worth acting on at all.
 *
 * The SDK exposes enablement as an evidence-gated boolean read and privacy mode as a write with no
 * readback, so enablement is the only observation live admission and HomeKit presentation can consult. The
 * requirement deliberately does not demand a writable member, because a camera that reports its state
 * without accepting a change is still observed. A camera whose manifest omits the row or reports it as
 * something other than a boolean read streams exactly as it would without the gate and has no state
 * published for it, because refusing on an absent observation would withdraw live view from a working
 * camera.
 *
 * A member the SDK names in `unreflectedMembers` is declined for the same reason, and declining means the
 * same thing everywhere: neither the gate nor the presentation acts. There the value is readable but does
 * not track the write it accepts, and a reading that can silently disagree with the device must not refuse
 * live view or publish a camera as switched off. No capability module in the pinned SDK declares the flag
 * that produces such a statement, so this declines nothing today and would decline a family the moment the
 * SDK stopped standing behind its reading.
 */
function observesEnablement(context: AdapterAttachmentContext, camera: CameraActions): boolean {
  return satisfiesMemberRequirements(context.evidence, [CAMERA_ENABLED_READ]) && !untrusted(camera, 'enabled');
}

/** Reads that observation where there is one, answering nothing for a reading that is absent or faults. */
function enablementObservation(camera: CameraActions, observed: boolean): () => boolean | undefined {
  if (!observed) {
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

/** Everything one attachment supplies to the camera operating mode service it presents and operates on. */
interface OperatingModeControls {
  readonly camera: CameraActions;
  readonly enablement: () => boolean | undefined;
  readonly observed: boolean;
  readonly issue: DeviceOperationIssuer;
  readonly readBoolean: (capability: string, member: string, read: () => unknown) => boolean;
  readonly readNumber: (capability: string, member: string, read: () => unknown) => number;
}

/** Reports the enablement observation behind an announced change, and withdraws what this bundle attached. */
interface OperatingModePresentation {
  observe(): AdapterEventTrace['observation'];
  remove(): void;
}

/**
 * Whether the SDK declines to stand behind one of this camera's readings on this device family.
 *
 * A member named there reports a value that does not track its own setter, so it may neither be presented nor
 * written: publishing it would state something the SDK does not, and writing it would leave HomeKit unable to
 * tell whether the write landed. The statement is read off the bound capability surface itself, so a surface
 * that answers that read by throwing has stated nothing this plugin may rely on and is declined too.
 */
function untrusted(camera: CameraActions, member: string): boolean {
  try {
    return unreflectedMembers(camera).includes(member);
  } catch {
    return true;
  }
}

/**
 * Attaches the controls this bundle owns on the one Camera Operating Mode service the accessory carries.
 *
 * A camera configured for HomeKit Secure Video already carries that service, created and owned by the HAP
 * recording controller, which documents attaching an optional characteristic to it rather than adding a
 * second service; a camera with no recording carries none, so this bundle adds one under its own stable
 * key. Exactly one may exist, because HAP identifies a service by type and subtype and the controller's own
 * carries an empty subtype: a plugin-owned service surviving from a run without recording would make the
 * controller's own service fail to attach.
 *
 * The camera's own power is deliberately not published here as HomeKit's `ManuallyDisabled`, and an accessory
 * restored from a version that published it has that state withdrawn along with the record kept for it. Apple
 * Home answers a camera reporting it by declining to write that camera's operating mode at all, so publishing
 * it costs the ability to switch the camera on from HomeKit — see `docs/architecture.md`. The power is offered
 * as the Camera Enabled switch instead, and a session a disabled camera cannot serve is still refused by its
 * own gate under a named reason.
 */
function operatingModePresentation(
  context: AdapterAttachmentContext,
  controller: CameraController,
  { camera, enablement, observed, issue, readBoolean, readNumber }: OperatingModeControls,
): OperatingModePresentation {
  const { hap } = context;
  const indicated = indicatesStatusLed(context, camera);
  const nightVisible = presentsNightVision(context, camera);
  /** Whether HomeKit's camera-active state is carried to the device, which needs a reading to compare against. */
  const carriesCameraActive = observed && satisfiesMemberRequirements(context.evidence, [CAMERA_ENABLED_WRITE]);
  let service: ReturnType<typeof operatingModeService> | undefined;
  let hooked = false;
  const resolve = () => {
    service ??= operatingModeService(context, controller);
    if (!hooked) {
      hooked = true;
      if (carriesCameraActive) {
        homeKitActiveOperation(context, service, { camera, enablement, issue });
      }
    }
    return service;
  };
  withdrawCharacteristic(context, controller, 'ManuallyDisabled');
  const retained = context.accessory.context as { homebridgeEufyCameraHomeKitActive?: unknown } | undefined;
  if (retained?.homebridgeEufyCameraHomeKitActive !== undefined) {
    delete retained.homebridgeEufyCameraHomeKitActive;
    context.persist();
  }
  if (!indicated) {
    withdrawCharacteristic(context, controller, 'CameraOperatingModeIndicator');
  }
  if (!nightVisible) {
    withdrawCharacteristic(context, controller, 'NightVision');
  }
  if (!carriesCameraActive && !indicated && !nightVisible) {
    removeOperatingMode(context);
    return { observe: enablementTrace(enablement), remove: () => undefined };
  }
  if (indicated) {
    const read = (): boolean => readBoolean('camera', 'statusLed', () => camera.statusLed);
    const indicator = resolve().getCharacteristic(hap.Characteristic.CameraOperatingModeIndicator);
    indicator.onGet(read);
    indicator.onSet((value: unknown) => {
      if (typeof value !== 'boolean') {
        throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }
      return issue(
        'camera',
        'statusLed',
        () => camera.setStatusLed!(value),
        () => {
          try {
            indicator.updateValue(read());
          } catch {}
        },
      );
    });
  }
  if (nightVisible) {
    nightVisionPresentation(context, resolve(), { camera, issue, readNumber });
  }
  resolve();
  return {
    observe: enablementTrace(enablement),
    remove(): void {
      removeOperatingMode(context);
    },
  };
}

/**
 * Reports whether the enablement observation answered, for the one trace an announced change records.
 *
 * The event is still acted on — a session watching a camera that just went off is ended at once — so the
 * trace states whether the reading behind that decision was there, without publishing anything from it.
 */
function enablementTrace(enablement: () => boolean | undefined): () => AdapterEventTrace['observation'] {
  return () => (enablement() === undefined ? 'missing' : 'valid');
}

/**
 * Carries HomeKit's own camera-active state through to the camera's power, where the camera accepts it.
 *
 * HomeKit owns this state: the Home app writes it when a camera is set to off for the mode the home is in,
 * and where HomeKit Secure Video created the service HAP gates streams, snapshots and recordings on it
 * itself — on a service this bundle publishes instead, HAP gates nothing and the state is carried only here.
 * Turning the camera off physically as well is this plugin's product policy, because a camera the user has
 * told HomeKit not to use is a camera they have asked not to be watched by, and leaving it powered means it
 * keeps recording to the vendor's cloud.
 *
 * Two things must be true before the camera is written:
 *
 * - **A controller wrote it.** An internal write carries no connection, so seeding a required state or
 *   restoring one cannot reach the device.
 * - **The camera disagrees.** A camera already off is not told to turn off, which also stops a command that
 *   cannot succeed from being reissued on every reconnection.
 *
 * A value a controller merely re-asserts is deliberately not rejected. HomeKit decides whether this camera is
 * on, so the state it holds is applied to a camera that disagrees with it however that state arrived — which
 * is also what reconciles the device after a restart, since the home hub re-asserts its per-mode setting when
 * the bridge reappears. Requiring the value to have moved instead left a divergence no action in the Home app
 * could resolve, because the only value a user can write is the one HomeKit already holds.
 *
 * A camera whose power this plugin cannot write still accepts the state, because refusing it would leave the
 * user unable to turn the camera off in HomeKit at all; the write is simply HomeKit's own then. A camera that
 * refuses the change has it reverted to what the camera reports, so HomeKit never keeps a claim the device did
 * not reach.
 */
function homeKitActiveOperation(
  context: AdapterAttachmentContext,
  service: ReturnType<typeof operatingModeService>,
  { camera, enablement, issue }: Pick<OperatingModeControls, 'camera' | 'enablement' | 'issue'>,
): void {
  const { hap } = context;
  const operable =
    satisfiesMemberRequirements(context.evidence, [CAMERA_ENABLED_WRITE]) &&
    typeof camera.setEnabled === 'function' &&
    !untrusted(camera, 'enabled');
  const active = service.getCharacteristic(hap.Characteristic.HomeKitCameraActive);
  /**
   * Answers HomeKit with the state HomeKit itself holds here, which this bundle only carries.
   *
   * The value is not this plugin's to decide, but the read must be answered all the same: HAP throws the
   * status a failed write left on a characteristic that registers no read handler, on every later read and
   * for good, so a camera whose power refused one write would be reported unresponsive until the bridge
   * restarted. Answering also clears that status, because HAP marks a served read successful.
   */
  active.onGet(() => active.value ?? hap.Characteristic.HomeKitCameraActive.ON);
  active.onSet(async (value: unknown, _context?: unknown, connection?: unknown) => {
    const enable = value === hap.Characteristic.HomeKitCameraActive.ON;
    if (!operable || connection === undefined || enablement() === enable) {
      return;
    }
    try {
      await issue(
        'camera',
        'enabled',
        () => camera.setEnabled!(enable),
        () => undefined,
      );
    } catch (error) {
      const enabled = enablement();
      if (enabled !== undefined) {
        active.updateValue(
          enabled ? hap.Characteristic.HomeKitCameraActive.ON : hap.Characteristic.HomeKitCameraActive.OFF,
        );
      }
      throw error;
    }
  });
}

/**
 * Presents night vision as the one boolean HomeKit carries, over the three modes the SDK reports.
 *
 * `Off` is the only mode that is not night vision, so anything else reads as on. Turning it on again restores
 * the mode this camera last reported for itself rather than a mode chosen here, because full colour night
 * vision is not offered by every model — the SDK says so, and writing infrared blindly would silently
 * downgrade a camera whose owner had chosen colour. That mode is retained on the accessory, so it survives a
 * reconciliation and a restart: an attachment-local memory would be empty exactly when the camera currently
 * reads off, which is when the restore matters. A camera whose lit mode has never been observed at all is
 * turned on to infrared, which is the mode the SDK reports for every family and the one it says a model may
 * offer without offering colour.
 *
 * A reading outside the modes the SDK declares is refused rather than projected, because "not off" would
 * otherwise make any unexpected number read as night vision and be written back as a mode.
 */
function nightVisionPresentation(
  context: AdapterAttachmentContext,
  service: ReturnType<typeof operatingModeService>,
  {
    camera,
    issue,
    readNumber,
  }: Pick<OperatingModeControls, 'camera' | 'issue'> & Pick<OperatingModeControls, 'readNumber'>,
): void {
  const { hap } = context;
  interface NightVisionContext {
    homebridgeEufyCameraNightVision?: { version: 1; mode: number };
  }
  const retained = (context.accessory.context ?? {}) as NightVisionContext;
  context.accessory.context = retained;
  const stored = retained.homebridgeEufyCameraNightVision;
  let lit =
    stored?.version === 1 && NIGHT_VISION_MODES.has(stored.mode) && stored.mode !== NightVision.Off
      ? stored.mode
      : undefined;
  const mode = (): number => {
    const reading = readNumber('camera', 'nightVision', () => camera.nightVision);
    if (!NIGHT_VISION_MODES.has(reading)) {
      context.diagnose({
        code: INVALID_OBSERVATION_CONDITION,
        capability: 'camera',
        member: 'nightVision',
        active: true,
        reason: 'malformed',
      });
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    if (reading !== NightVision.Off && lit !== reading) {
      lit = reading;
      retained.homebridgeEufyCameraNightVision = { version: 1, mode: reading };
      context.persist();
    }
    return reading;
  };
  const characteristic = service.getCharacteristic(hap.Characteristic.NightVision);
  characteristic.onGet(() => mode() !== NightVision.Off);
  characteristic.onSet((value: unknown) => {
    if (typeof value !== 'boolean') {
      throw new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const requested = value ? (lit ?? NightVision.Infrared) : NightVision.Off;
    return issue(
      'camera',
      'nightVision',
      () => camera.setNightVision!(requested),
      () => {
        try {
          characteristic.updateValue(mode() !== NightVision.Off);
        } catch {}
      },
    );
  });
}

/** Whether this camera reports its night-vision mode and accepts a change to it. */
function presentsNightVision(context: AdapterAttachmentContext, camera: CameraActions): boolean {
  return (
    satisfiesMemberRequirements(context.evidence, [CAMERA_NIGHT_VISION_READ, CAMERA_NIGHT_VISION_WRITE]) &&
    typeof camera.setNightVision === 'function' &&
    !untrusted(camera, 'nightVision')
  );
}

/**
 * Whether this camera's indicator LED may be presented and operated: the SDK reports its state as an
 * exactly evidenced boolean, accepts a write for it, and installed the setter on this device. A camera that
 * offers the setter without reporting the state publishes nothing, because a control HomeKit cannot read is
 * a control it would answer with a guess.
 */
function indicatesStatusLed(context: AdapterAttachmentContext, camera: CameraActions): boolean {
  return (
    satisfiesMemberRequirements(context.evidence, [CAMERA_STATUS_LED_READ, CAMERA_STATUS_LED_WRITE]) &&
    typeof camera.setStatusLed === 'function' &&
    !untrusted(camera, 'statusLed')
  );
}

/**
 * The operating mode service this accessory already carries, without creating one.
 *
 * Exactly one may exist: the recording controller's own where HomeKit Secure Video created it, this
 * bundle's own under its stable key, or one the accessory restored from a cached run whose recording is no
 * longer configured, which carries no subtype and would otherwise make a second service look absent.
 */
function existingOperatingMode(context: AdapterAttachmentContext, controller: CameraController) {
  const { accessory, hap } = context;
  return (
    controller.recordingManagement?.operatingModeService ??
    accessory.getServiceById(hap.Service.CameraOperatingMode, CAMERA_OPERATING_MODE_SERVICE_KEY) ??
    accessory.services.find((service) => service.UUID === hap.Service.CameraOperatingMode.UUID)
  );
}

/** That service, adding this bundle's own when the accessory carries none. */
function operatingModeService(context: AdapterAttachmentContext, controller: CameraController) {
  return existingOperatingMode(context, controller) ?? publishedOperatingMode(context);
}

/**
 * Withdraws one state this plugin published, because a stale published value is a claim about a camera
 * nothing is checking any more. Only the characteristic is withdrawn here: a controller-owned service is
 * not this bundle's to remove, and a service this bundle owns is removed by its caller once nothing at all
 * is left to publish on it.
 */
function withdrawCharacteristic(
  context: AdapterAttachmentContext,
  controller: CameraController,
  attached: 'ManuallyDisabled' | 'CameraOperatingModeIndicator' | 'NightVision',
): void {
  const service = existingOperatingMode(context, controller);
  const characteristic = context.hap.Characteristic[attached];
  if (service?.testCharacteristic(characteristic)) {
    service.removeCharacteristic(service.getCharacteristic(characteristic));
  }
}

/**
 * This bundle's own Camera Operating Mode service, seeded with the two states HomeKit requires it to carry.
 *
 * Both are seeded active because this camera does stream and does answer snapshot requests, and the
 * recording controller seeds its own service the same way. Neither is driven from a device observation:
 * HomeKit owns them, and on a controller-owned service HAP itself gates streams and snapshots on the
 * HomeKit-active state.
 */
function publishedOperatingMode(context: AdapterAttachmentContext) {
  const { accessory, hap } = context;
  const service = accessory.addService(
    hap.Service.CameraOperatingMode,
    accessory.displayName,
    CAMERA_OPERATING_MODE_SERVICE_KEY,
  );
  service.setCharacteristic(hap.Characteristic.HomeKitCameraActive, hap.Characteristic.HomeKitCameraActive.ON);
  service.setCharacteristic(hap.Characteristic.EventSnapshotsActive, hap.Characteristic.EventSnapshotsActive.ENABLE);
  return service;
}

/** Withdraws this bundle's own operating mode service, leaving a controller-owned one to its owner. */
function removeOperatingMode(context: AdapterAttachmentContext): void {
  const service = context.accessory.getServiceById(
    context.hap.Service.CameraOperatingMode,
    CAMERA_OPERATING_MODE_SERVICE_KEY,
  );
  if (service) {
    context.accessory.removeService(service as never);
  }
}

/** Reduces only a well-formed, correctly attributed SDK observation to snapshot presentation state. */
function availabilityObservation(
  serial: string,
  read: AdapterAttachmentContext['availability'],
): () => 'available' | 'unavailable' | undefined {
  return () => {
    try {
      const observation = read?.();
      if (
        !observation ||
        observation.entity?.kind !== 'device' ||
        observation.entity.sn !== serial ||
        observation.scope !== 'device' ||
        observation.source?.transport !== 'smqtt' ||
        observation.source.signal !== 'state-info' ||
        (observation.availability !== 'available' && observation.availability !== 'unavailable') ||
        !Number.isFinite(observation.receivedAt) ||
        (observation.observedAt !== undefined && !Number.isFinite(observation.observedAt)) ||
        (observation.sequence !== undefined && !Number.isFinite(observation.sequence))
      ) {
        return undefined;
      }
      return observation.availability;
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
  source?: CameraMediaSource;
  snapshotMedia?: SnapshotMediaAdapter;
  capturedFallback?: boolean;
}

interface CameraMediaSource extends LiveMediaSource, SnapshotMediaSource, RecordingMediaSource {}

/**
 * Why live view is unavailable for a camera an admitted observation reports as disabled: it was refused
 * before any transport was opened, an active session was ended when the camera went off, or a session the
 * camera did accept answered with audio and never a video frame.
 */
type LiveAdmissionRefusal = 'disabled' | 'disabled-mid-session' | 'disabled-no-video';

/** Why live view is unavailable for a camera the declared concurrent media ceiling had no room for. */
type MediaCapacityRefusal = 'at-capacity';

/**
 * What an attachment given no budget counts against: nothing, because nothing was declared.
 *
 * Normalising the absent budget to one that admits everything keeps a single encoding of "no ceiling". Reading
 * the absence at each decision instead would make one `undefined` mean both "nothing was declared" and "the
 * host has no room", which are opposite answers.
 */
const UNBOUNDED_MEDIA: MediaSessionBudget = { claim: () => ({ release: () => undefined }) };

/**
 * Why a snapshot request went unanswered: the acquisition the media policy names, or the snapshot
 * adaptation this plugin never composed, which no acquisition could report because none was reached.
 */
type SnapshotUnavailability = SnapshotFailure | 'adapter-missing';

/** Everything one attachment supplies to the stable camera delegate, rebound on each reconciliation. */
interface LiveCameraBinding {
  readonly source: CameraMediaSource;
  readonly media: LiveMediaAdapter;
  readonly snapshotMedia?: SnapshotMediaAdapter;
  readonly audioEnabled: boolean;
  readonly snapshotMode: SnapshotMode;
  readonly enablement: () => boolean | undefined;
  readonly availability: () => 'available' | 'unavailable' | undefined;
  readonly reportSession: (outcome: LiveSessionOutcome, switchedOff?: boolean) => void;
  readonly reportRelease: () => void;
  readonly reportTalkback: (outcome: TalkbackOutcome) => void;
  readonly reportAdmission: (refusal?: LiveAdmissionRefusal) => void;
  readonly reportCapacity: (refusal?: MediaCapacityRefusal) => void;
  readonly budget?: MediaSessionBudget;
  readonly reportSnapshot: (failure?: SnapshotUnavailability) => void;
  readonly reportSelection?: AdapterAttachmentContext['trace'];
}

/** Owns HomeKit camera negotiation while delegating source adaptation to the media domain. */
class LiveCameraDelegate implements CameraStreamingDelegate {
  controller?: CameraController;
  /** Assigned once the accessory has a service to present on, which is only true after the controller is. */
  private readonly sessions = new Map<string, PendingSession>();
  private readonly prepareGenerations = new Map<string, symbol>();
  /**
   * The share of host capacity each HomeKit session holds, keyed by the identifier HomeKit gave it.
   *
   * One session is one share however often its endpoints are negotiated. A controller may answer
   * `SetupEndpoints` again for a session it already has, and the replacement is only recorded once the new
   * preparation succeeds, so a share held per prepared session would have that controller competing with
   * itself and refuse it at a ceiling it is already inside.
   */
  private readonly claims = new Map<string, MediaSessionClaim>();
  private readonly snapshotScope: SnapshotAcquisitionScope;
  private acceptingSessions = true;
  private refused = false;
  private capacityRefused = false;
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
   * observation because a camera that is off is presented rather than photographed.
   *
   * A request no camera image could answer latches exactly one bounded reason naming the acquisition that
   * left it unanswered, and keeps it until a later real image withdraws it, so an intermittently failing
   * camera is distinguishable in the log from one that is permanently unequipped: the intermittent one
   * latches and clears repeatedly, while the unequipped one latches once. The reason is latched whether a
   * placeholder was substituted or the request failed outright, and a live refresh that fails afterwards
   * supersedes it while the camera still has nothing to show.
   *
   * A disabled camera latches nothing: its image is the intended presentation, and live view already reports
   * why it cannot be watched. A camera with no snapshot adaptation at all latches the missing adaptation
   * itself, because no acquisition was reached to report anything about.
   */
  handleSnapshotRequest(_request: never, callback: (error?: Error, buffer?: Buffer) => void): void {
    const snapshotMedia = this.binding.snapshotMedia;
    if (!snapshotMedia) {
      this.binding.reportSnapshot('adapter-missing');
      callback(new Error('camera snapshot adaptation is unavailable'));
      return;
    }
    let unanswered = false;
    const enabled = this.binding.enablement();
    const availability = this.binding.availability();
    void snapshotMedia
      .acquire(this.snapshotScope, this.binding.source, this.binding.snapshotMode, {
        ...(enabled === undefined ? {} : { enabled }),
        ...(availability === undefined ? {} : { availability }),
        onUnavailable: (failure) => {
          unanswered = true;
          this.binding.reportSnapshot(failure);
        },
      })
      .then(
        (buffer) => {
          if (!unanswered) {
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
    if (!this.claimCapacity(request.sessionID)) {
      callback(new Error('the declared concurrent media limit is reached'));
      return;
    }
    const generation = Symbol('camera-stream-prepare');
    this.prepareGenerations.set(request.sessionID, generation);
    void this.prepare(request).then(
      ({ response, session }) => {
        if (!this.acceptingSessions || this.prepareGenerations.get(request.sessionID) !== generation) {
          session.prepared.stop();
          this.releaseUnheldClaim(request.sessionID);
          callback(new Error('live media preparation was cancelled'));
          return;
        }
        const superseded = this.sessions.get(request.sessionID);
        this.sessions.delete(request.sessionID);
        this.prepareGenerations.delete(request.sessionID);
        superseded?.prepared.stop();
        this.sessions.set(request.sessionID, session);
        this.admit();
        this.withdrawCapacityRefusal();
        callback(undefined, response);
      },
      (error: unknown) => {
        if (this.prepareGenerations.get(request.sessionID) === generation) {
          this.prepareGenerations.delete(request.sessionID);
        }
        this.releaseUnheldClaim(request.sessionID);
        callback(error instanceof Error ? error : new Error('failed to prepare live media'));
      },
    );
  }

  /**
   * Holds this session's share of the declared media ceiling, reporting one bounded reason where the host has
   * no room for it.
   *
   * The share is taken before any await, so two cameras asked at once cannot both pass the same check. It is
   * held for the whole session lifetime rather than only while media flows, because a prepared session holds a
   * reserved port and HomeKit bounds it by its own connection; releasing it earlier would let a controller
   * that prepares and waits sit outside the count it was admitted under.
   */
  private claimCapacity(sessionID: string): boolean {
    if (this.claims.has(sessionID)) {
      return true;
    }
    const claim = (this.binding.budget ?? UNBOUNDED_MEDIA).claim();
    if (!claim) {
      this.capacityRefused = true;
      this.binding.reportCapacity('at-capacity');
      return false;
    }
    this.claims.set(sessionID, claim);
    return true;
  }

  /** Gives back a share taken for a preparation that never became a session, and only then. */
  private releaseUnheldClaim(sessionID: string): void {
    if (this.sessions.has(sessionID)) {
      return;
    }
    this.claims.get(sessionID)?.release();
    this.claims.delete(sessionID);
  }

  /** Withdraws a latched capacity refusal once a session is admitted again, and only then. */
  private withdrawCapacityRefusal(): void {
    if (!this.capacityRefused) {
      return;
    }
    this.capacityRefused = false;
    this.binding.reportCapacity();
  }

  private async prepare(request: PrepareStreamRequest) {
    const videoSsrc = this.hap.CameraController.generateSynchronisationSource();
    const audioSsrc = this.binding.audioEnabled ? this.hap.CameraController.generateSynchronisationSource() : undefined;
    let session: PendingSession | undefined;
    const prepared = await this.binding.media.prepare({
      addressVersion: request.addressVersion,
      targetAddress: request.targetAddress,
      video: mediaTarget(request.video, this.hap),
      ...(this.binding.audioEnabled ? { audio: mediaTarget(request.audio, this.hap) } : {}),
      onVideoFailure: () => {
        this.controller?.forceStopStreamingSession(request.sessionID);
        this.release(request.sessionID);
      },
      onSessionOutcome: (outcome) => {
        const switchedOff =
          outcome.outcome === 'failed' && outcome.reason === 'source-audio-only' && this.binding.enablement() === false;
        if (switchedOff) {
          this.refused = true;
        }
        this.binding.reportSession(outcome, switchedOff);
        if (
          outcome.outcome === 'streaming' &&
          session?.source &&
          session.snapshotMedia?.captureFromWarmLive &&
          !session.capturedFallback
        ) {
          session.capturedFallback = true;
          void session.snapshotMedia.captureFromWarmLive(this.snapshotScope, session.source).catch(() => undefined);
        }
      },
      onSessionReleased: this.binding.reportRelease,
      onTalkbackOutcome: (outcome) => this.binding.reportTalkback(outcome),
    });
    session = {
      prepared,
      videoSsrc,
      ...(audioSsrc === undefined ? {} : { audioSsrc }),
      ...(this.binding.snapshotMedia ? { snapshotMedia: this.binding.snapshotMedia } : {}),
    };
    return {
      session,
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
      this.traceSelection('reconfigure', video);
      callback();
      return;
    }
    if (this.refuseWhenDisabled('disabled')) {
      this.release(request.sessionID);
      callback(new Error('camera is disabled'));
      return;
    }
    session.selection = request;
    const video = negotiatedVideo(request.video, session.videoSsrc, this.hap);
    this.traceSelection('start', video);
    const source = this.binding.source;
    session.source = source;
    this.supervise();
    void session.prepared
      .start(source, {
        video,
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

  private traceSelection(operation: 'start' | 'reconfigure', video: NegotiatedLiveVideo): void {
    this.binding.reportSelection?.({
      event: 'live-video-selected',
      operation,
      profile: video.profile,
      level: video.level,
      width: video.width,
      height: video.height,
      fps: video.fps,
    });
  }

  stop(): void {
    this.acceptingSessions = false;
    for (const sessionID of [...this.sessions.keys()]) {
      this.release(sessionID);
    }
    for (const claim of this.claims.values()) {
      claim.release();
    }
    this.claims.clear();
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
    this.claims.get(sessionID)?.release();
    this.claims.delete(sessionID);
    if (this.sessions.size === 0) {
      this.unsupervise();
    }
  }

  /** Reports one refusal when an admitted observation says the camera is disabled. */
  private refuseWhenDisabled(refusal: LiveAdmissionRefusal): boolean {
    const enabled = this.binding.enablement();
    if (enabled !== false) {
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
    this.supervision = setInterval(() => this.observeEnablement(), ENABLEMENT_SUPERVISION_INTERVAL_MS);
    this.supervision.unref?.();
  }

  /**
   * Acts on the enablement observation as it reads now, whether an announced change or the supervision tick
   * asked. A camera with nothing being watched needs no action here: presentation already followed the
   * change, and admission is decided when the next session asks.
   */
  observeEnablement(): void {
    if (this.sessions.size === 0 || !this.refuseWhenDisabled('disabled-mid-session')) {
      return;
    }
    for (const sessionID of [...this.sessions.keys()]) {
      this.controller?.forceStopStreamingSession(sessionID);
      this.release(sessionID);
    }
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
  readonly prebufferLengthMs: number;
  readonly enablement: () => boolean | undefined;
  readonly reportRecording: (outcome: RecordingOutcome) => void;
  readonly reportAdmission: (refusal?: RecordingAdmissionRefusal) => void;
}

/**
 * Owns HomeKit Secure Video negotiation while delegating fragment adaptation to the media domain.
 *
 * Nothing is held between recordings and no source is ever opened to build pre-event media. A camera
 * eligible to retain a window has it configured on the shared source its live view and its recordings both
 * use, so a recording drains whatever that source happened to be carrying and begins at its trigger
 * otherwise. HomeKit persists whether recording is active and which configuration was selected, and this
 * delegate keeps both only so that a recording request can be answered.
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
   * stop maintaining pre-event media, and no camera here maintains any on HomeKit's word: an eligible
   * camera's window is configured on its shared source and fills only while something else is already
   * streaming, so there is nothing to start or stop.
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
   * camera's audio off, and whenever a controller selected a codec or sample rate this camera never
   * advertised, because a recording with no audio track is the truthful answer in every one of those cases
   * and a substituted codec would not be.
   *
   * The pre-event window a controller selected is asked for up to what this camera retains, so a controller
   * asking for less asks for less and one asking for more than was advertised gets the advertised window.
   * The selection is a request rather than a bound, because how much media a source has retained is the
   * source's own answer.
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
      prebufferLengthMs: Math.max(0, Math.min(configuration.prebufferLength, binding.prebufferLengthMs)),
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
    const codec =
      configuration.audioCodec.type === this.hap.AudioRecordingCodecType.AAC_ELD
        ? ('AAC-eld' as const)
        : configuration.audioCodec.type === this.hap.AudioRecordingCodecType.AAC_LC
          ? ('AAC-lc' as const)
          : undefined;
    const rates = RECORDING_SAMPLE_RATES(this.hap);
    const sampleRate = RECORDING_AUDIO_SAMPLE_RATES.find((rate) => rates[rate] === configuration.audioCodec.samplerate);
    if (!codec || sampleRate === undefined) {
      return undefined;
    }
    return {
      codec,
      channels: configuration.audioCodec.audioChannels ?? 1,
      sampleRate,
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

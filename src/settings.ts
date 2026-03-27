/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'EufySecurity';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = '@homebridge-plugins/homebridge-eufy-security';

// HomeKit Secure Video segment length, in milliseconds. HomeKit only supports this value currently.
export const PROTECT_HKSV_SEGMENT_LENGTH = 4000;

// HomeKit Secure Video maximum event recording errors to accept before resetting a connection to the Protect controller.
export const PROTECT_HKSV_MAX_EVENT_ERRORS = 3;

// HomeKit Secure Video timeshift buffer default length, in milliseconds. This defines how far back in time we can look when we see a motion event.
export const PROTECT_HKSV_TIMESHIFT_BUFFER_MAXLENGTH = PROTECT_HKSV_SEGMENT_LENGTH * 2;

// HomeKit Secure Video segment resolution, in milliseconds. This defines the resolution of our buffer. It should never be less than 100ms or greater than 1500ms.
export const PROTECT_HKSV_SEGMENT_RESOLUTION = 100;

// Additional headroom for bitrates beyond what HomeKit is requesting when streaming to improve quality with a minor additional bandwidth cost.
export const PROTECT_HOMEKIT_STREAMING_HEADROOM = 64;

// HomeKit prefers a video streaming I-frame interval of 2 seconds.
export const PROTECT_HOMEKIT_IDR_INTERVAL = 2;

// Minimum required GPU memory on a Raspberry Pi for hardware acceleration.
export const PROTECT_RPI_GPU_MINIMUM = 128;

// FFmpeg afftdn audio filter defaults - this setting uses FFTs to reduce noise in an audio signal by the number of decibels below.
export const PROTECT_FFMPEG_AUDIO_FILTER_FFTNR = 90;

// Maximum age of a snapshot in seconds.
export const PROTECT_SNAPSHOT_CACHE_MAXAGE = 90;

// How often, in seconds, should we heartbeat FFmpeg in two-way audio sessions. This should be less than 5 seconds, which is FFmpeg's input timeout interval.
export const PROTECT_TWOWAY_HEARTBEAT_INTERVAL = 3;

export const SnapshotUnavailablePath = '/media/Snapshot-Unavailable.png';

// Seconds – cache age threshold for the fast-path snapshot return.
export const SNAPSHOT_CACHE_FRESH_SECONDS = 15;

// Seconds – balanced-mode cache age threshold before fetching a new snapshot.
export const SNAPSHOT_CACHE_BALANCED_SECONDS = 30;

// Milliseconds – don't overwrite a recent stream snapshot with a cloud image.
export const SNAPSHOT_CLOUD_SKIP_MS = 30 * 1000;

// Milliseconds – maximum time to wait for a snapshot fetch before timing out.
export const SNAPSHOT_FETCH_TIMEOUT_MS = 30 * 1000;

// Milliseconds – how much raw P2P video data to keep in the prebuffer ring buffer.
// Used to provide instant data to FFmpeg on HKSV recording start (eliminates probe delay).
// At typical Eufy bitrates (1–2 Mbps) this is roughly 0.5–1 MB of memory per camera.
export const PREBUFFER_DURATION_MS = 4_000;

// Bytes per millisecond – conservative estimate for ring buffer sizing.
// 2 Mbps = 250 KB/s = 0.25 bytes/ms × 1000 = 250 bytes/ms.
export const PREBUFFER_ESTIMATED_BYTE_RATE = 250;
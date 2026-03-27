# HKSV Recording Reliability Fix

**PR:** [#878](https://github.com/homebridge-plugins/homebridge-eufy-security/pull/878)
**Branch:** `fix/hksv-recording-reliability`
**Affects:** All cameras with HomeKit Secure Video enabled

---

## Problem

HKSV recordings never appeared in the Apple Home timeline. Users could enable HKSV in Apple Home settings, but no recordings were captured on motion events. Two independent issues combined to make HKSV completely non-functional.

## Root Cause 1: HKSV state lost on every restart

### How HKSV state persistence works

When a user enables HKSV for a camera in Apple Home:

1. HomeKit sets the `Active` characteristic to `true` on the `CameraRecordingManagement` service
2. HAP-NodeJS stores this in two places:
   - The `cachedAccessories` JSON (service characteristic values)
   - The `ControllerStorage` file (controller-specific state)
3. On next boot, `CameraController._initWithServices()` restores services from cache
4. `ControllerStorage.restoreController()` calls `deserialize()` to restore `recordingActive`

### What was broken

`CameraAccessory.configureVideoStream()` removed two controller-managed services (`CameraOperatingMode` and `DataStreamTransportManagement`) from the cached accessory before calling `configureController()`. This was added to prevent a "duplicate UUID error".

However, this broke the restoration flow:

```
HAP-NodeJS CameraController._initWithServices():

  IF all 3 services found in cache:
    → Reuse cached services (preserves Active state) ✓

  ELSE (any service missing):
    → Create NEW services with Active=false ✗
```

By removing 2 of the 3 services, every restart forced the `ELSE` path, resetting `recordingActive` to `false`. HomeKit set `Active=true` once, but it was lost on every boot.

### The fix

Removed the stale service removal code entirely. HAP-NodeJS's `_initWithServices()` already handles service reuse through its `serializedControllers` path — the "duplicate UUID error" it was designed to prevent doesn't occur when services are properly managed by the controller.

## Root Cause 2: P2P cold-start delay

### The timing problem

When HomeKit requests an HKSV recording after motion detection, the recording delegate must:

1. Establish a P2P connection to the camera (`getLocalLiveStream()`)
2. Start FFmpeg to transcode the stream
3. Begin yielding fMP4 fragments to HomeKit

Step 1 takes **~4.8 seconds** (observed in diagnostics). HomeKit has an approximate **5-second timeout** for the first data. This means recordings frequently failed to start in time.

### How reference implementations solve this

| Plugin | Approach | Prebuffer Duration |
|--------|----------|--------------------|
| homebridge-unifi-protect | Always-on RTSP timeshift buffer | Configurable |
| Scrypted | Ring buffer, 2.5x HomeKit's prebufferLength | 10s default |
| homebridge-camera-ui | Always-on prebuffer | 4s |

All use prebuffering. For battery-powered Eufy cameras, always-on prebuffering is not viable.

### The fix: motion-triggered P2P pre-warming

When the plugin detects motion (before HomeKit even requests a recording), it proactively starts the P2P connection:

```
Motion Detected → Plugin sets MotionDetected=true on characteristic
                → Plugin calls preWarmStream() (P2P starts in background)
                → HomeKit receives motion notification
                → HomeKit sends DATA_SEND OPEN → handleRecordingStreamRequest()
                → getLocalLiveStream() returns instantly (P2P already warm)
```

A new `preWarmStream()` method on `LocalLivestreamManager` starts the P2P connection without creating a consumer fork. The stream auto-cleans up after the `STOP_GRACE_MS` (5 seconds) grace period if HomeKit doesn't request a recording.

RTSP cameras are excluded from pre-warming since their stream URL is immediately available.

## Additional fix: updateRecordingActive log bug

`recordingDelegate.ts` line 282 had swapped log arguments:

```typescript
// Before (wrong — message as camera name, camera name as message):
log.debug(`Recording: ${active}`, this.accessory.displayName);

// After (correct):
log.info(this.camera.getName(), `HKSV recording enabled/disabled by HomeKit.`);
```

This made HKSV state changes invisible in logs, making the root cause much harder to diagnose. Promoted to INFO level since this is a critical diagnostic signal.

## HKSV Recording Flow (Architecture Reference)

```
┌─────────────────────────────────────────────────────────────┐
│                     eufy-security-client                     │
│  Device emits 'motion detected' / 'person detected' / etc.  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    CameraAccessory.ts                         │
│  1. characteristic.updateValue(true)  → HomeKit notified     │
│  2. preWarmStream()                   → P2P starts warming   │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
┌──────────────────────┐   ┌─────────────────────────────────┐
│  LocalLivestream     │   │  HAP-NodeJS RecordingManagement  │
│  Manager.ts          │   │                                   │
│  P2P connecting...   │   │  HomeKit receives MotionDetected  │
│  Stream warming...   │   │  HomeKit decides to record        │
│  ✓ Stream ready     │   │  DATA_SEND OPEN →                 │
└──────────┬───────────┘   └───────────────┬───────────────────┘
           │                               │
           │                               ▼
           │               ┌───────────────────────────────────┐
           │               │  recordingDelegate.ts              │
           │               │  handleRecordingStreamRequest()    │
           └──────────────►│  configureInputSource()            │
             P2P already   │    → getLocalLiveStream() instant  │
             warm!         │  FFmpeg starts                     │
                           │  yield fMP4 fragments → HomeKit    │
                           └───────────────────────────────────┘
```

## Files Changed

| File | Change |
|------|--------|
| `src/accessories/CameraAccessory.ts` | Removed stale service removal; added motion-triggered pre-warming |
| `src/controller/LocalLivestreamManager.ts` | Added `preWarmStream()` method; updated `isStreamActive()` |
| `src/controller/recordingDelegate.ts` | Fixed `updateRecordingActive` log arguments |

## User Impact

### After upgrading

Users who had HKSV enabled but never saw recordings should see them start working. Some users may need to:

1. Restart Homebridge after the upgrade
2. If recordings still don't appear, toggle HKSV off and on in Apple Home:
   - Open Home app → Camera settings → Recording Options → Disable → Re-enable

### Battery considerations

The P2P pre-warming starts a livestream connection on every motion event. For battery-powered cameras:
- The stream only runs for 5 seconds if HomeKit doesn't request a recording
- This is similar to what already happens for snapshot fetching on motion
- Impact on battery life should be minimal but is worth monitoring

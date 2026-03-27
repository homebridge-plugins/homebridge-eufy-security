# Debug Recording Pipeline — Lessons Learned (PRs #888–#894, 2026-03-26)

Six PRs in one day to fix a feature that should have landed in one or two. Root causes were not understanding the FFmpeg process architecture, fixing symptoms instead of root causes, and not testing against real hardware before merging.

## 1. Understand the P2P FFmpeg process architecture BEFORE touching it

P2P cameras use SEPARATE FFmpeg processes for video and audio. The video process has only one input (raw H264 via TCP). There is no `input 1` for audio. Any `-map 1:a` on the video process will fail silently or crash.

**Rule**: Before adding FFmpeg arguments, trace the FULL command that gets spawned. Check `ffmpeg-<serial>.log` in diagnostics. Verify what each input index maps to.

**Why**: PRs #888, #890, #891 all tried to add audio to the video process file tee — impossible by architecture. Three PRs wasted.

**How to apply**: When modifying `getCombinedArguments()` or `buildRawMuxArgs()`, always log or mentally construct the full FFmpeg command and verify each `-i` and `-map` index.

## 2. Homebridge plugin UI runs in an iframe with strict CSP

Homebridge enforces `frame-src 'self' data: https://developers.homebridge.io`. This means:
- `data:` URIs work for downloads
- `blob:` URLs are BLOCKED

**Rule**: Never use `URL.createObjectURL()` / `blob:` for downloads in the plugin UI. Use the same `btoa()` + `data:` URI pattern as diagnostics download.

**Why**: PR #893 switched to Blob URLs for "memory efficiency", immediately broke downloads. Had to revert.

**How to apply**: When writing download logic in `homebridge-ui/`, copy the pattern from `diagnostics.js` `_downloadDiagnostics()`. Check CSP before changing.

## 3. Destroy PassThrough forks when their consumer dies

When piping a source stream to multiple PassThrough forks via `.pipe()`, if ANY fork's consumer dies (e.g., FFmpeg crashes) and the fork is not destroyed, it fills its internal buffer (16KB default) and applies permanent backpressure on the source — starving ALL other consumers.

**Rule**: Always destroy PassThrough forks when their downstream consumer exits. Store references and destroy in cleanup handlers.

**Why**: PR #888 created forks without cleanup. The bug was masked by 4MB highWaterMark in #890, exposed when removed in #891, finally fixed in #893.

**How to apply**: Any time you create a `new PassThrough()` and pipe a shared source into it, ensure the fork is destroyed when its consumer (FFmpeg, socket, etc.) exits. Use both socket `close` handler AND session cleanup as belt-and-suspenders.

## 4. FFmpeg ignores stdin when reading from TCP

When FFmpeg reads input from a TCP socket (`-i tcp://...`), it is blocked in the socket read loop and does NOT monitor stdin. Writing `'q'` or `'q\n'` to stdin has no effect. The process will never exit gracefully via stdin.

**Rule**: To stop FFmpeg reading from TCP, destroy the TCP socket. FFmpeg detects EOF and exits cleanly, finalizing the container.

**Why**: PR #888 used `stdin.write('q')`, #893 added newline, neither worked. FFmpeg was always SIGKILL'd after timeout. PR #894 fixed it by destroying the socket.

**How to apply**: In `stopSessionBySerial()`, destroy `session.videoSocket` and `session.audioSocket` instead of writing to stdin.

## 5. P2P data is inherently bursty — never use wallclock timestamps

`-use_wallclock_as_timestamps 1` assigns PTS based on when FFmpeg receives each frame. P2P delivers data in bursts at every level: initial buffer dump, ongoing video chunks (~1.3s gaps between bursts), and audio (entire ADTS batch arrives in one TCP write). Wallclock faithfully records these arrival times, producing choppy video and crushed audio (25s of audio crammed into 2ms of timestamps).

Deferred piping (PR #891) only prevents the initial buffer dump. It does NOT make ongoing P2P delivery real-time.

**Rule**: Never use `-use_wallclock_as_timestamps` for P2P recordings. Use `-fflags +genpts -r <fps>` for video (generates smooth PTS from declared framerate) and `-fflags +genpts` for audio (generates PTS from sample rate). The FPS comes from `metadata.videoFPS`.

**Why**: PR #888 used wallclock -> burst -> 0.07s. PR #894 used wallclock + deferred piping -> choppy video (1.3s frame gaps) and silent audio (all timestamps within 2ms). PR #897 uses genpts + fps from metadata.

**How to apply**: In `buildRawMuxArgs()`, use `-fflags +genpts -r <fps>` before each input. Deferred piping in `LocalLivestreamManager.onStationLivestreamStart` is still needed to prevent the initial buffer burst from skewing the generated PTS.

## 6. The processed file tee copies raw INPUT, not encoded OUTPUT

In FFmpeg multi-output, `-map 0:v -c:v copy` on a second output copies from INPUT 0 (raw P2P), not the encoded output of the first output. To capture the encoded stream, you'd need the `tee` muxer (blocked by SRTP params) or double encoding (wasteful).

**Rule**: Don't use the file tee to capture "what HomeKit sees". It captures the raw P2P feed. For P2P cameras, use DebugRecordingManager instead (captures both video+audio). Keep the file tee only for RTSP cameras where DebugRecordingManager doesn't apply.

**Why**: PRs #888-#891 assumed the file tee captured the encoded stream. It never did.

## 7. HomeKit probes streams with a stop/restart cycle

HomeKit sends startStream -> runs for 2-3s -> sends stopStream -> waits -> sends startStream again. This is normal probe behavior. If the file recording uses the P2P sessionId (which persists across HomeKit sessions), the second start overwrites the first file.

**Rule**: For any per-HomeKit-session file recording, use `request.sessionID` (HomeKit's session ID), not the P2P livestream sessionId.

**How to apply**: Relevant if the RTSP file tee is ever extended. Currently moot for P2P since the file tee was removed.

## 8. Test against real hardware before merging

Every PR #888-#893 was merged and found broken on the next beta. A single 15-second test (enable debug livestream -> stream camera -> check recording) would have caught most issues immediately.

**Rule**: Before merging debug recording changes, the test plan MUST actually be executed. At minimum: enable feature, stream for 15s, ffprobe the output, check eufy-security.log for errors.

**Why**: The ADTS crash (FFmpeg exit 255) was visible in the very first test. The 0.07s duration was visible in the first ffprobe. Six PRs could have been two.

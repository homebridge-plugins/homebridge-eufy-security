# Validate a local plugin build with Homebridge

Use this procedure after an implementation passes its hermetic contracts. Live validation supplements
the test suite; it does not replace it and must not introduce real device or account data into the
repository, issue tracker, or shared logs.

## 1. Record the build under test

From the plugin checkout:

```bash
pwd
git status --short --branch
git rev-parse HEAD
node --version
npm run verify
```

Confirm that `pwd` is the checkout Homebridge actually loads. If the service uses a global install,
inspect the package path before replacing anything:

```bash
npm root --global
npm list --global @homebridge-plugins/homebridge-eufy-security --depth=0
```

Do not infer the loaded version from the source checkout alone. The startup log must identify the
plugin version after restart.

## 2. Restart Homebridge

Run these commands as the account that owns the Homebridge service and storage directory:

```bash
hb-service restart
hb-service view
```

`hb-service restart` performs a normal service restart. `hb-service view` shows a bounded recent log
window and returns, which is preferable for a repeatable check. Use the streaming view only while
actively reproducing a problem:

```bash
hb-service logs
```

Stop the streaming view with `Ctrl+C`; this does not stop Homebridge.

If restart fails, inspect service state before retrying:

```bash
systemctl status homebridge --no-pager
journalctl --unit homebridge --since "10 minutes ago" --no-pager
```

The service name can differ on non-default installations. Pass the same `--service-name` value used
when that Homebridge service was installed.

## 3. Check the Homebridge log

After restart, verify all of the following in `hb-service view`:

1. Homebridge starts without an uncaught exception or plugin load error.
2. The expected Homebridge Eufy version is loaded once.
3. The runtime reaches `ready`, or reports one explicit actionable condition.
4. No second SDK owner, repeated authentication loop, or accessory registration loop appears.
5. The expected accessory containers are restored without duplicate registrations.

Do not paste complete logs into an issue. Record timestamps and retain only the smallest allowlisted,
redacted excerpt needed to explain a failure.

## 4. Check the plugin JSONL log

The default V5 plugin log is relative to the Homebridge storage directory:

```text
homebridge-eufy/logs/homebridge-eufy.jsonl
```

For the standard Linux service storage root, inspect a bounded recent section with:

```bash
tail -n 100 /var/lib/homebridge/homebridge-eufy/logs/homebridge-eufy.jsonl
```

Follow it only during a short reproduction interval:

```bash
tail -f /var/lib/homebridge/homebridge-eufy/logs/homebridge-eufy.jsonl
```

Stop following with `Ctrl+C`. Rotated archives are in the same directory and should remain local
unless a maintainer requests a specific bounded excerpt. The JSONL log can contain support-sensitive
diagnostic context even though output is allowlisted; redact serials, device names, account IDs,
addresses, URLs, tokens, keys, and session material before sharing anything.

## 5. Run an observation-first fleet check

Use a synthetic alias in notes rather than a real device name or serial. For each selected camera:

1. Confirm the accessory appears once and its existing identity is retained.
2. Open the live view and record whether first video arrives, its orientation, and approximate startup
   time.
3. Verify video with normal source audio, then verify a camera known to provide no audio still shows
   uninterrupted video.
4. Leave the view open long enough to cross one source GOP and one RTCP interval.
5. Change Home app orientation or quality only if needed to cause a normal reconfigure request; verify
   the session remains usable.
6. Close the view and verify the source and FFmpeg processes stop without repeated cleanup errors.
7. Check both `hb-service view` and the bounded plugin JSONL interval for one start and one stop, with no
   sensitive payload or raw media output.

Opening a live stream wakes some battery cameras and consumes a bounded media budget. Do not toggle
lights, alarms, locks, arming state, microphone settings, or other persistent controls unless that
operation class has separate explicit approval.

## 6. Drive the same paths without a Home app

The harnesses in `scripts/` pair a real HAP controller against a dedicated Homebridge instance, so live
camera acceptance does not depend on adding a bridge in the Home app. Each script documents its own
prerequisites and options in its file header; all of them need a Homebridge instance that is **not** paired
to any controller and a `hap-controller` module installed outside this repository.

| Script                                | What it qualifies                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `live-hap-snapshot-check.mjs`         | HomeKit snapshot requests, retained image policy, and on-disk modes           |
| `live-hap-stream-check.mjs`           | Negotiated live streaming, measured on the decrypted wire                     |
| `live-hap-repeated-start-check.mjs`   | Repeated cold-start comparison with bounded lifecycle attribution             |
| `live-hap-codec-matrix-check.mjs`     | One session per advertised profile and level, judged for exact coded fidelity |
| `live-hap-prepared-session-check.mjs` | What a prepared session that never starts holds, and what releases it         |
| `live-hap-disabled-camera-check.mjs`  | Live view, snapshots, and recovery for a camera that is turned off            |
| `live-hap-capture.mjs`                | One MP4 and still per camera when a maintainer must look at a frame           |
| `live-hksv-check.mjs`                 | Negotiated HomeKit Secure Video output, measured on the adapted fragments     |
| `live-talkback-check.mjs`             | Audible return audio, one SDK handle, and isolated outbound media             |

`live-hap-stream-check.mjs` decrypts and authenticates the inbound SRTP with the keys it supplied, so it
judges what the accessory actually encoded rather than what a command line asked for: negotiated payload
type and synchronisation source, coded dimensions, profile and level from the sequence parameter sets,
frame rate, keyframe cadence, and bit rate. It also drives the cases a Home app only reaches by chance:

```bash
node scripts/live-hap-stream-check.mjs \
  --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
  --seconds 25 --concurrent --homebridge-pid <homebridge pid>
```

- a mid-session reconfiguration must change the coded dimensions on the wire while the session keeps its
  synchronisation source, its SRTP key, and its single adaptation process;
- `--concurrent` negotiates a second session on the camera's second stream management service, and ending
  one must leave the other streaming;
- `--homebridge-pid` counts adaptation processes during and after the session and matches the negotiated
  selection against their arguments, which are never printed because they carry SRTP key material;
- a battery camera bounds a continuous stream with a power budget the plugin must extend, so use
  `--seconds 60` or more with `--battery` to cross that boundary.

Every run reads the accessory's own `SupportedVideoStreamConfiguration` first, reports the advertised
profiles, levels and resolutions, and refuses a selection outside that matrix before negotiating anything.
An accessory answers an unadvertised selection without complaint, so a run that skipped that step would
measure a combination no controller would ever ask for.

Coded profile, level and dimensions are judged exactly. Constrained Baseline is the realization of a
Baseline selection, which is the one substitution the negotiated contract admits; a coded profile or level
below the negotiated one fails the run. Measured frame rate and bit rate remain upper-bound checks, because
a camera that delivers fewer frames than negotiated is normal.

`live-hap-codec-matrix-check.mjs` walks the whole advertised matrix in one pairing, one bounded session per
profile and level, and prints what each session requested next to what it coded:

```bash
node scripts/live-hap-codec-matrix-check.mjs \
  --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
  --seconds 8 --homebridge-pid <homebridge pid>
```

Each combination is a complete session on a cold source, so budget minutes rather than seconds. Point
`--width` and `--height` at one advertised resolution to sweep the profiles and levels there, or add
`--all-resolutions` to multiply the sweep by every advertised resolution. Measured on a wired camera, all
nine advertised profile and level combinations code exactly at `1280x720@30` and again at `1920x1080@30`:
the encoder writes the negotiated level literally, including a level whose own frame-size limit the
negotiated geometry exceeds, so an out-of-spec triple in the advertised matrix shows up as an exact pass
here and has to be judged from the matrix itself rather than from a coded parameter set.

The measurement itself is covered hermetically by `test/contracts/live-hap-harness.test.ts`, so a green
live result is not the only evidence that the harness reads packets correctly.

Use `live-hap-repeated-start-check.mjs` when one camera starts less reliably than a control. Authorize and
start a guided diagnostics reproduction with the `live-media` profile, select exactly two camera accessory
ids, and keep network conditions fixed for the whole alternating run:

```bash
node scripts/live-hap-repeated-start-check.mjs \
  --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
  --aids 6,14 --attempts 5 --seconds 10 --profile high --level 4.0 \
  --homebridge-pid <homebridge pid> \
  --jsonl /tmp/hb-check/homebridge-eufy/logs/homebridge-eufy.jsonl
```

The script alternates cameras to reduce time-of-run bias. A failed attempt is assigned to HAP preparation,
SDK source acquisition, first source keyframe, first adapted output, controller RTCP, or cleanup from the
narrowest evidence observed. Successful attempts report the selected profile, level, geometry, frame rate,
and first-video latency, then require the stream service, adaptation processes, and SDK consumer to release.

`live-hap-stream-check.mjs` also requests one snapshot in the middle of the session. The session must keep
its synchronisation source, its SRTP key, its in-use status, and its single adaptation process across it. A
first request may legitimately be refused on a camera that has no retained image yet and no stored
acquisition, exactly as in `live-hap-snapshot-check.mjs`, so a refused first round settles for
`--snapshot-settle-ms` and retries. Use `--serial` to pin the run to one camera when a fleet has several
wired ones, and remember that snapshot acquisition is per-camera: a camera whose live still never succeeds
fails this step for reasons that have nothing to do with streaming.

`live-hap-disabled-camera-check.mjs` is the only live script that writes to a device, so it needs explicit
approval and a camera named by `--serial`. It streams while the camera is enabled, turns it off, measures
how long the plugin takes to end the session, confirms a new session is refused while it stays off,
confirms snapshots stay reachable, then turns it back on and confirms a session is admitted again. It
restores the camera's original state in a `finally` block, and it refuses to start from a camera that is
already off so it can only ever restore what it changed.

```bash
node scripts/live-hap-disabled-camera-check.mjs \
  --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
  --serial T8XXXXXXXXXXXXXX --eufy-storage /tmp/hb-check/homebridge-eufy \
  --homebridge-pid <homebridge pid> --instance-log /tmp/hb-check/instance.log
```

Refusal is proven by an `ERROR` status from `SetupEndpoints` together with the
`camera-live-session-refused` condition in the Homebridge log; a `BUSY` status means a session was still
holding that stream management service and proves nothing. Mid-session termination depends on the
enablement observation actually changing inside a running plugin, which
[eufy-sdk#47](https://github.com/mega-yfue/eufy-sdk/issues/47) currently prevents, so expect that step to
report a timeout until it is fixed.

`live-hap-prepared-session-check.mjs` covers the case a Home app cannot be asked for: a controller that
negotiates endpoints and then never starts. It holds one prepared session idle for `--idle-seconds`,
confirming through the accessory's own streaming status and the bound UDP ports on the host that the
reservation is still held, that no adaptation process exists for the whole window, and that a start
written after it still streams. It then abandons a prepared session and closes the controller connection,
which must release the reservation, return the stream management service to available, and refuse a start
for the released session.

```bash
node scripts/live-hap-prepared-session-check.mjs \
  --device-id AA:BB:CC:DD:EE:FF --address 127.0.0.1 --port 51955 --pin 000-00-000 \
  --idle-seconds 600 --homebridge-pid <homebridge pid>
```

`live-hksv-check.mjs` is the one check here that does not pair a controller. HomeKit transports a recording
over a HomeKit Data Stream, and `hap-controller` does not implement one, so an unpaired controller cannot
open a recording stream at all. The check drives the plugin's own recording adaptation directly instead,
with a configuration a controller could select, and judges the bytes that came out rather than the command
line that asked for them: the initialization segment, the boxes each fragment is made of, the coded
profile, level and dimensions read from the sequence parameter set inside `avcC`, whether every fragment
opens on a sample a decoder can start from, each fragment's span on the media timeline, whether an audio
track is present, and how long first output and cancellation took.

```bash
node scripts/live-hksv-check.mjs \
  --storage /tmp/hb-check/homebridge-eufy --serial T8XXXXXXXXXXXXXX --seconds 35
node scripts/live-hksv-check.mjs \
  --storage … --serial … --no-audio --width 1280 --height 720 --fps 15 --bitrate 800 \
  --profile main --level 3.1 --fragment-ms 2000 --iframe-ms 2000
node scripts/live-hksv-check.mjs \
  --storage … --serial … --warm-seconds 20 --prebuffer-ms 4000 --seconds 25
```

It opens a second realtime owner against a copy of the storage root, so **stop the instance under test
first**; it needs a built `dist/`, because it reuses the plugin's own adaptation and persistence; and it
never writes media to disk.

`--warm-seconds` is what exercises pre-event media. A mains-powered camera admitted to HomeKit Secure Video
has its shared source opened with a four-second window, and only a source something already opened can be
carrying anything, so without `--warm-seconds` the run records from a source nothing had opened and reports
the pre-event measurement as unverified. With it, the check opens the source exactly as the plugin does,
lets the window fill, then measures the media the recording received faster than real time — media that
could only have been captured before the recording attached. Measured on one wired camera, that was at
least 4.53 s for a four-second window, with every drained fragment opening on a keyframe. The estimate is
deliberately conservative, because media drained into the very first fragment is charged to that fragment
rather than counted. A drain opens on the newest retained keyframe at or before its cutoff, so it covers the
requested window when enough media exists and may exceed it by the distance to that keyframe. A source
configured with `--prebuffer-ms 0`, which is what a battery or solar camera gets, retains and drains none.

A first media call may spend the SDK session's best-effort level-2 grace, but that grace is not restarted by
each recording. On an already-warm wired source, the first source fragment arrived 18 ms after the request
and the adapted initialization segment followed in 266 ms. A fragment's span may exceed the selected
fragment length by up to one source frame, because a boundary can only land on a coded frame and a camera
may code slower than the frame rate that was selected; the check measures that frame interval from the
fragment rather than assuming the negotiated one.

The measurement itself is covered hermetically by `test/contracts/live-hksv-harness.test.ts`, so a green
live result is not the only evidence that the check reads a fragmented MP4 correctly.

A camera that is switched off answers this check with `source-error` and no output, which is correct: the
recording delegate refuses such a camera before opening a transport at all, so the failure only appears
when the check is pointed straight at the adaptation.

What this check does not cover is the HomeKit Data Stream transport and playback in the Home app. The
recording delegate's HAP surface — the advertised container and trigger, the configuration a controller
selects, recording-audio state, cancellation, and the failure conditions — is covered hermetically against
the real HAP definitions in `test/contracts/camera-streaming-adapter.test.ts`. Playable recordings with
expected audio remain a paired Home app acceptance step.

### Talkback write

`live-talkback-check.mjs` is different from the observation-only checks above: it opens the real camera
speaker and plays a short synthetic tone. Run it only with explicit approval, with the Homebridge owner
stopped, and against a copy of the storage root:

```bash
node scripts/live-talkback-check.mjs \
  --storage /tmp/hb-check/homebridge-eufy --serial T8XXXXXXXXXXXXXX --battery --seconds 2
```

The local controller side emits the exact 16 kHz mono AAC-ELD SRTP HomeKit negotiates. The plugin receives
that endpoint through its own return-audio FFmpeg adaptation, emits 16 kHz mono AAC-LC ADTS to one SDK
talkback handle, and stops that handle with the media session. On an approved battery-doorbell run the path
reported one `talking` outcome, exactly one handle opened and stopped, no isolated talkback failure, and no
outbound media failure. The tool is excluded from the installed package because it writes audible media to
a real device.

## 7. Record the result safely

Record only:

- commit and package version;
- Node.js, Homebridge, and plugin versions;
- synthetic camera alias and broad power class, such as wired or battery;
- observation class, such as H.264 video, H.265 video, audio present, or audio absent;
- timestamps, pass or fail, and an allowlisted condition code;
- whether Homebridge and plugin logs were checked.

Never record real serials, device names, addresses, account identifiers, tokens, keys, raw frames, or
complete logs.

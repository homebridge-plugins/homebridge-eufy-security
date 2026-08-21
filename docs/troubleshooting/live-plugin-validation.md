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

| Script | What it qualifies |
| --- | --- |
| `live-hap-snapshot-check.mjs` | HomeKit snapshot requests, retained image policy, and on-disk modes |
| `live-hap-stream-check.mjs` | Negotiated live streaming, measured on the decrypted wire |
| `live-hap-prepared-session-check.mjs` | What a prepared session that never starts holds, and what releases it |
| `live-hap-capture.mjs` | One MP4 and still per camera when a maintainer must look at a frame |

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

A coded profile or level below the negotiated one is a pass: a controller that offered `main` at level
3.1 decodes the constrained-baseline stream low-latency adaptation produces. Measured frame rate and bit
rate are upper-bound checks, because a camera that delivers fewer frames than negotiated is normal.

The measurement itself is covered hermetically by `test/contracts/live-hap-harness.test.ts`, so a green
live result is not the only evidence that the harness reads packets correctly.

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

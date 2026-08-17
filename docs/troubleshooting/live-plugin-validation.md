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

## 6. Record the result safely

Record only:

- commit and package version;
- Node.js, Homebridge, and plugin versions;
- synthetic camera alias and broad power class, such as wired or battery;
- observation class, such as H.264 video, H.265 video, audio present, or audio absent;
- timestamps, pass or fail, and an allowlisted condition code;
- whether Homebridge and plugin logs were checked.

Never record real serials, device names, addresses, account identifiers, tokens, keys, raw frames, or
complete logs.

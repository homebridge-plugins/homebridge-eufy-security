# Contributing

Thanks for helping. This file covers setup, development workflow, and pull requests. Architecture and
code rules are in [AGENTS.md](./AGENTS.md); read them before changing the plugin.

## License

The project is licensed under [Apache-2.0](./LICENSE). By opening a pull request, you agree that your
contribution is provided under the same license.

## Setup

```bash
nvm use
npm install
npm run verify
```

Node 24.5.0 or newer is required. `npm run verify` runs the same local quality gate expected before a
pull request: formatting, the guard against restoring `eufy-security-client`, the build, and the
hermetic Vitest contracts.

## Architecture

The SDK owns verified Eufy device truth and transport behavior. This plugin owns Homebridge lifecycle
and HomeKit representation. Use explicit capability and bundle adapters; do not infer services from
primitive SDK shapes and do not bypass evidence-gated SDK operations.

The current vocabulary is in [CONTEXT.md](./CONTEXT.md).

## Development workflow

- Start from the active `beta-X.Y.Z` branch and open the pull request against that branch unless a
  maintainer says otherwise.
- Use Conventional Commits.
- Keep each change focused and run `npm run verify` before requesting review.
- Do not add `Co-authored-by` trailers automatically.
- Explain new runtime dependencies, including why existing dependencies or `node:*` APIs are
  insufficient and what transitive/audit cost is introduced.
- Treat real-device access as read-only unless the owner explicitly approves a write operation.

### Live camera snapshot qualification

`npm run verify` stays hermetic, so HomeKit-initiated snapshots are qualified separately by
`scripts/live-hap-snapshot-check.mjs`. It pairs one temporary HAP controller against a dedicated,
unpaired Homebridge instance running this plugin, issues real snapshot resource requests, checks the
retained last successful images on disk, and removes its own pairing. The script header states the
prerequisites, including why a production bridge cannot be used and how to provide `hap-controller`
without changing this repository's lockfile.

`scripts/live-hap-stream-check.mjs` qualifies negotiated live streaming the same way: it drives complete
`SetupEndpoints` / start / RTCP / reconfigure / end-session cycles, authenticates and decrypts the
inbound SRTP with the keys it supplied so it can judge the coded dimensions, profile, level, frame rate,
keyframe cadence, and bit rate the accessory actually produced, negotiates a concurrent second session
with `--concurrent`, matches the negotiated selection against the adaptation process arguments, and
confirms no adaptation process survives the session. It measures decrypted media and keeps none of it.

`scripts/live-hap-repeated-start-check.mjs` alternates bounded cold starts between two explicitly selected
cameras. Battery cameras require the deliberate `--battery` flag. It reports per-camera pass/fail totals,
attributes each failure to HAP preparation, SDK source acquisition, first source keyframe, first adapted
output, controller RTCP, or cleanup, and requires both the identity-free selected-video trace and complete
FFmpeg/SDK-consumer release after every successful attempt.

`scripts/live-hap-codec-matrix-check.mjs` qualifies the whole advertised codec matrix: it reads what the
accessory advertises, negotiates one bounded session per advertised profile and level, and requires each
coded parameter set to carry exactly the combination its session requested. Every live script reads the
advertisement first and refuses a selection outside it, because an accessory answers an unadvertised
selection without complaint.

Both report the accessory id, product model, and power class for every camera they touch, so a recorded
result identifies its subject without naming rooms.

`scripts/live-hap-prepared-session-check.mjs` qualifies the reservation a prepared live session holds: it
writes `SetupEndpoints`, never starts, and observes for as long as `--idle-seconds` that the accessory
still reports the session as set up, that the answered port stays bound, and that no adaptation process
exists, then proves a start written after that whole window still streams. It also abandons a prepared
session and closes the controller connection, which must release the reservation and refuse a later start.

`scripts/hap-live-harness.mjs` owns the controller session mechanics these scripts share: HAP TLV
encoding, camera selection, the advertised video vocabulary and the refusal of a selection outside it,
endpoint setup, negotiated start, reconfigure and end commands, receiver reports, SRTP measurement, and
the acceptance rules that judge one measured window. Its measurement is covered hermetically by
`test/contracts/live-hap-harness.test.ts`, so a green live result is not the only evidence that the
harness reads packets correctly.

`scripts/live-hap-capture.mjs` is the visual counterpart: it decrypts one negotiated session per camera
and writes an MP4 plus a still frame for inspection. It writes real camera imagery, refuses to write
inside a git working tree, and its output must stay out of repositories, backups, issues, and support
archives.

Record the result with the live acceptance evidence for the change. A live acquisition or session wakes
a camera, so every script uses wired cameras unless `--battery` is passed.

## Pull requests

Keep the body concise and developer-focused:

- what changed and why;
- what was verified;
- device, Homebridge, or Home app evidence used;
- anything unverified, intentionally omitted, or deferred;
- migration or release impact.

Never include real serials, P2P identifiers, account or user IDs, device names, addresses,
credentials, tokens, keys, logs, or captures. Use synthetic placeholders and review the diff before
submission.

## Release notes

Release notes are for users. Put required actions, compatibility changes, removed settings, and
behavior changes first. Avoid internal milestones and implementation detail.

## Working with AI agents

- Point the agent at [AGENTS.md](./AGENTS.md), [CONTEXT.md](./CONTEXT.md), and relevant ADRs.
- Verify every claimed SDK symbol and behavior against the current checkout.
- Do not let an agent infer protocol behavior from an older third-party Eufy client.
- Review generated output for secrets, real device data, incompatible code, and unsupported claims.
- The contributor remains responsible for every submitted line.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](./SECURITY.md).

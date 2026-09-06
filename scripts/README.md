# Maintainer scripts

Index of the tooling in this directory. `npm run verify` stays hermetic, so anything requiring a real
account, camera, or transport lives here instead of in `test/contracts/`.

Read a script's own header before running it. Headers state prerequisites, flags, and why the check
cannot be hermetic.

## What writes

No script in this directory reaches an installed plugin: `.npmignore` excludes the whole of it, and the
packed contract pins the shipped set as empty. Most are observation-only. These are not, so they belong only
to a host whose owner has approved a real-device write:

| Script                                | What it writes                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| `eufy-camera-power.mjs`               | Moves one camera's enablement state                                 |
| `live-hap-disabled-camera-check.mjs`  | Turns a camera off and on again                                     |
| `live-hap-operating-mode-check.mjs`   | Turns a camera off and on again through HomeKit, with `--serial`    |
| `live-talkback-check.mjs`             | Plays audio through a camera speaker                                |
| `authentication-handoff-evidence.mjs` | Takes one ownership lease against a live storage root               |
| `qualify-authentication-handoff.sh`   | Provisions a throwaway Homebridge instance and replaces its account |

Real-device writes require the owner's explicit approval. Observation-only verification is the default.

## Live camera qualification

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

`scripts/live-adaptation-delivery-check.mjs` measures what live adaptation did with the access units it was
given, which `npm run verify` pins the input contract for but cannot code. It drives the plugin's own
`FfmpegLiveMedia` and requires every fed access unit to be accounted for in the coded output, allowing only
the duplication or thinning a constant-rate output legitimately performs, and requires first output not to
wait on the source keyframe interval. `--serial` runs it on a real SDK live source against a copy of the
storage root; `--paced` runs it on a locally encoded stream, once per requested keyframe interval, which is
the comparison that shows first output does not scale with that interval. Both report the source geometry
changes a window contained, because each one replaces the adaptation process.

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

`scripts/live-hap-disabled-camera-check.mjs` qualifies a camera that has no video to give: it proves the
accessory presents the camera as disabled once it is switched off, refuses a session for it, ends one that
was already running, and reverses both when the camera comes back on. What Apple Home renders from that
presented state is not observable from a controller and remains a human check.

`scripts/live-hap-operating-mode-check.mjs` qualifies the camera operating mode service: what every camera
publishes on it, and — with `--serial` — that HomeKit's own camera-active state is carried through to that
camera's power and back again. The indicator LED and night vision are read but not written there, because both
are timed-write characteristics that HAP refuses to a controller which cannot prepare a write; their write
paths are held by the contract suite instead.

`scripts/live-hksv-check.mjs` qualifies negotiated HomeKit Secure Video output measured on the adapted
fragments. `scripts/live-talkback-check.mjs` qualifies the controller-to-camera return-audio path.

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

### Comparing two revisions

Pin the selection to what the accessory advertises, and read the advertisement in both runs rather than
assuming it held. An accessory's advertised resolution list is not a constant: it can move from a generic
fallback to one derived from each camera's native geometry as the plugin learns that geometry, and every
script refuses a selection outside the advertisement. A comparison whose two halves ran at different
geometries measures the advertisement rather than the change, and the halves that refuse measure nothing at
all — an inconclusive run, which is reported as inconclusive rather than as a pass.

Prefer one downtime window containing both revisions over two windows separated in time: build the first
revision, run every camera, build the second, run them again, all against one storage copy taken once. That
removes the account and registry state drift between runs, and it is also less total downtime than two
windows, because the dedicated instance starts once per revision instead of once per run.

## Live authentication qualification

`scripts/qualify-authentication-handoff.sh` walks a maintainer through one real handoff of a dedicated
guest account from temporary custom-UI authentication to the long-lived runtime, and
`scripts/authentication-handoff-evidence.mjs` collects the evidence behind each acceptance criterion. The
full procedure, including which claims are already proven hermetically and which need a real account, is
in [docs/troubleshooting/live-authentication-handoff.md](../docs/troubleshooting/live-authentication-handoff.md).

The wizard never asks for the account password; it is typed only into the Homebridge UI. The evidence
harness prints no credential, account address, device serial, or device name, and no digest or length of
one, because its output is assembled into a report intended for a public issue. Its `sinks`, `ownership`,
and `acquisition` subcommands only read, so they are safe against a running instance; `conflict` takes an
ownership lease against a live storage root and belongs only to a throwaway instance.

`scripts/eufy-camera-session.mjs` opens one typed SDK camera session for live acceptance against a
**copy** of a persisted storage root, so it never takes the lease a running plugin owns.

## Support and repository tooling

| Script                    | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `decrypt-diagnostics.mjs` | Decrypts and extracts a support archive a user sent in               |
| `sync-device-artwork.mjs` | Regenerates bundled device artwork                                   |
| `guard-no-ecs.sh`         | Repository gate: fails if `eufy-security-client` reappears           |
| `qualify-release.mjs`     | Release gate: refuses a tree whose SDK or contents cannot be shipped |

`qualify-release.mjs` runs from `prepublishOnly`, after `npm run verify`, because it asserts what only a
publishable tree can satisfy: the SDK resolves to one exact published version from a trusted registry, with
the integrity the lockfile records, and is not the symbolic link a working checkout uses. It then scans the
packed file list and the tracked sources for private keys, bearer tokens, cloud credentials, and retained
support archives. It cannot detect real device data, because a serial or P2P identifier is required to be
synthetic and correctly shaped, so a pattern matching a real one matches every fixture; that remains a review
obligation.

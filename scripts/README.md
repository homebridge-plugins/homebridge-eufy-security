# Maintainer scripts

Index of the tooling in this directory. `npm run verify` stays hermetic, so anything requiring a real
account, camera, or transport lives here instead of in `test/contracts/`.

Read a script's own header before running it. Headers state prerequisites, flags, and why the check
cannot be hermetic.

## Classification

Most scripts are observation-only. These are not, and are excluded from the published package by
`.npmignore`:

| Script | What it writes |
| --- | --- |
| `eufy-camera-power.mjs` | Moves one camera's enablement state |
| `live-hap-disabled-camera-check.mjs` | Turns a camera off and on again |
| `live-talkback-check.mjs` | Plays audio through a camera speaker |
| `authentication-handoff-evidence.mjs` | Takes one ownership lease against a live storage root |
| `qualify-authentication-handoff.sh` | Provisions a throwaway Homebridge instance and replaces its account |

Real-device writes require the owner's explicit approval. Observation-only verification is the default.

## HomeKit media qualification

| Script | Qualifies |
| --- | --- |
| `hap-live-harness.mjs` | Shared controller session mechanics the checks below use |
| `live-hap-snapshot-check.mjs` | HomeKit-initiated snapshots and retained last successful images |
| `live-hap-stream-check.mjs` | Negotiated live streaming, measured on decrypted SRTP |
| `live-hap-codec-matrix-check.mjs` | Every advertised profile and level |
| `live-hap-repeated-start-check.mjs` | Repeated cold starts, with per-failure attribution |
| `live-hap-prepared-session-check.mjs` | A prepared session that never starts |
| `live-hap-disabled-camera-check.mjs` | A camera that has no video to give |
| `live-hksv-check.mjs` | HomeKit Secure Video fragments |
| `live-talkback-check.mjs` | Controller-to-camera return audio |
| `live-hap-capture.mjs` | Writes an MP4 and a still for visual inspection |

## Authentication and account qualification

Detailed procedure:
[docs/troubleshooting/live-authentication-handoff.md](../docs/troubleshooting/live-authentication-handoff.md).

| Script | Purpose |
| --- | --- |
| `qualify-authentication-handoff.sh` | Walks a maintainer through one real guest-account handoff (issue #1024) |
| `authentication-handoff-evidence.mjs` | Collects the redacted evidence behind each acceptance criterion |
| `eufy-camera-session.mjs` | Opens one SDK camera session against a **copy** of a storage root |

The wizard never asks for the account password; it is typed only into the Homebridge UI. The evidence
harness prints no credential, account address, device serial, or device name, and no digest or length of
one, because its output is assembled into a report intended for a public issue.

## Support and repository tooling

| Script | Purpose |
| --- | --- |
| `decrypt-diagnostics.mjs` | Decrypts and extracts a support archive a user sent in |
| `sync-device-artwork.mjs` | Regenerates bundled device artwork |
| `guard-no-ecs.sh` | Repository gate: fails if `eufy-security-client` reappears |

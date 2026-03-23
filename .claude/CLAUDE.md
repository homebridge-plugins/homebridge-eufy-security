# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the homebridge-eufy-security plugin.

## Project Overview

Homebridge plugin that exposes Eufy Security devices to Apple HomeKit. Published as `@homebridge-plugins/homebridge-eufy-security` under the `homebridge-plugins` GitHub organization.

Depends on `eufy-security-client` (upstream: bropat/eufy-security-client) for cloud API, P2P, push notifications, and MQTT communication.

For detailed functional requirements, device coverage, configuration options, and architecture boundaries, see `.claude/PRD.md`.

## Build & Dev Commands

```bash
npm run build          # rimraf dist -> tsc -> copy media/ to dist/
npm run build-plugin   # rimraf dist -> tsc (no media copy)
npm run lint           # eslint 'src/**/*.ts' --max-warnings=0
npm run lint-fix       # eslint with --fix
```

- No test suite -- there are no unit or integration tests
- Output: `dist/`
- `--max-warnings=0` is enforced -- all warnings must be fixed before committing
- ESLint uses flat config (`eslint.config.mjs`); `@typescript-eslint/no-explicit-any` is globally disabled -- do not add eslint-disable comments for it
- Run `npm run lint` and `npm run build` before pushing

## Architecture

Entry point `src/index.ts` registers `EufySecurityPlatform` with Homebridge. The platform class (`src/platform.ts`) is the core -- it initializes the `EufySecurity` client, discovers devices, and creates HomeKit accessories.

**Accessory classes** in `src/accessories/` map Eufy device types to HomeKit services:
- `BaseAccessory.ts` -- root base class (characteristic registration, service pruning)
- `Device.ts` (`DeviceAccessory`) -- extends `BaseAccessory`; adds sensor/battery services, property helpers
- `CameraAccessory` -- cameras, doorbells, floodlights (handles streaming delegates); extends `DeviceAccessory`
- `StationAccessory` -- base stations (security system service for arm/disarm); extends `BaseAccessory` directly
- `LockAccessory`, `EntrySensorAccessory`, `MotionSensorAccessory`, `SmartDropAccessory` -- extend `DeviceAccessory`
- `AutoSyncStationAccessory` -- virtual accessory that syncs station guard mode with HomeKit

**Streaming pipeline** in `src/controller/`:
- `streamingDelegate.ts` -- HomeKit camera streaming (FFmpeg-based)
- `recordingDelegate.ts` -- HomeKit Secure Video recording
- `snapshotDelegate.ts` -- snapshot handling
- `LocalLivestreamManager.ts` -- manages P2P livestream sessions

**Utilities** in `src/utils/`: logging (`utils.ts`), FFmpeg wrapper (`ffmpeg.ts`), two-way audio (`Talkback.ts`), config schema (`configTypes.ts`), internal interfaces (`interfaces.ts`).

**Constants** in `src/settings.ts`: HKSV segment lengths, snapshot cache ages, streaming bitrate headroom, IDR intervals -- reference this when tuning streaming or recording behaviour.

**Plugin UI** in `homebridge-ui/`: `server.js` (plain JS, eslint-ignored) handles UI server logic and diagnostics generation. The UI and the plugin runtime (`src/`) are **separate processes** that share state through `accessories.json` on disk (written by `src/utils/accessoriesStore.ts`, read by `homebridge-ui/server.js`). Both independently import `eufy-security-client` types (`DeviceType`, `PropertyName`, `Device`, etc.) -- changes to the device/station record shape must be kept in sync between `accessoriesStore.ts` and `server.js`.

### Key source files for device registration and triage

- `src/platform.ts` (`register_device`) -- device registration logic; devices can stack multiple capabilities (independent `if` blocks, not `else if`)

## Key Technical Details

- ESM project (`"type": "module"`, `"module": "NodeNext"`) -- imports must use `.js` extensions (NodeNext resolution requires explicit extensions)
- TypeScript strict mode, ES2022 target (`noImplicitAny: false` relaxes implicit-any checks)
- Node.js 20, 22, or 24 required
- Homebridge >=1.9.0 or ^2.0.0-beta
- Uses `ffmpeg-for-homebridge` for video transcoding
- `src/version.ts` is auto-generated at prebuild time -- do not edit manually
- `prepublishOnly` runs lint + build automatically before `npm publish`
- For local development, `eufy-security-client` can be pointed to a local path (e.g. `"../eufy-security-client"`)

## Git Workflow

**IMPORTANT: Create the branch BEFORE editing any files.**

```bash
# Create dedicated branch from beta before making any changes
git checkout beta-*.*.* && git pull origin beta-*.*.*
git checkout -b [fix/feat/chore]/<short-description>

# Stage and commit each change individually
git add <file>
git commit -m "fix: <concise description of what changed and why>"

# Push and create PR
git push -u origin fix/<short-description>
gh pr create --base beta-*.*.* --title "<concise title>" --body-file /tmp/pr-body.md
```

- Branch from `beta-*.*.*`, not `master`
- PR target: `beta-*.*.*`
- Branch naming: `fix/`, `feat/`, `chore/` prefix

### Commit message rules

- Single line, no line breaks mid-sentence
- Describe the **spirit** of the change, not the code diff
- No Co-Authored-By

### PR body

- Write to `/tmp/pr-body-<branch>.md` using file creation -- **never** use heredoc (`cat << EOF`) in the terminal (quotes and special characters break it)
- Describe the **spirit** of the change, not the code diff
- Concise description of the problem and fix
- PR body is **not** the release note -- keep it focused on the code change for reviewers
- No Co-Authored-By

### Release notes

- Write to `/tmp/release-notes-<version>.md` using file creation
- **Audience is end users** -- focus on what matters to them: new devices, behaviour changes, removed settings, required actions
- **Concise, bullet-driven** -- no markdown tables, no verbose paragraphs. Short section intros (1-2 sentences max) followed by bullet lists
- **No internal milestones** -- don't mention "first GA since X" or beta iteration counts
- **Structure for a branch** (e.g., `4.4.x`), not a single version:
  - Individual `## v4.4.x` entries at the top with version-specific changes
  - A shared `## What's in 4.4.x` section below covering the full branch
- **Required actions front and center** -- if users need to change config or upgrade Node.js, say so early and clearly
- **Tone**: direct, no filler, no emojis

### Issue comments

- Use `gh issue comment <number> --repo homebridge-plugins/homebridge-eufy-security --body "<message>"`
- Use first person ("I")
- Thank the user by @mention
- Be formal and concise
- **Audience is end users** -- keep language simple, no internal jargon
- Don't scope a fix to a specific device when it applies broadly
- When a fix is merged, check the published beta version (`npm view @homebridge-plugins/homebridge-eufy-security dist-tags`) and mention it in the comment

## Dependency Policy -- `eufy-security-client`

**CRITICAL:**
- **`beta-*.*.*` branches** -- use the `dev` dist-tag (`"eufy-security-client": "dev"`)
- **`master` branch** -- **NEVER** use the `dev` dist-tag. Always use a pinned stable version (e.g. `"^3.7.2"`). Before merging to master, replace `"dev"` with the corresponding stable release version.

When updating the `eufy-security-client` version in `package.json`:
1. Check the upstream changelog and README at https://github.com/bropat/eufy-security-client/blob/master/README.md
2. Identify breaking changes, new features, or device support changes
3. Summarize the impact in the PR body
4. If there are breaking changes, note any required code adjustments

## Skills

Skills in `.claude/skills/` provide structured workflows for common tasks:

| Skill | Purpose |
|---|---|
| `planner` | Build a step-by-step action plan with guardrails before coding |
| `developer` | Execute code changes following an approved plan or direct instructions |
| `qa` | Verify build, lint, imports, architecture, and git hygiene before pushing |
| `architect` | Quick codebase questions, mini-bug debugging, workflow improvement |
| `support` | Triage GitHub issues using diagnostics archives and logs |
| `new-device-support` | Full workflow to add a new Eufy device type across both repos |

Typical flow: **planner** -> **developer** -> **qa**. Use **architect** for exploration and **support** for issue triage.

## Diagnostic Triage

For issue triage, use the `support` skill with an issue number (e.g. `/support 423`). For the full triage reference, see `.github/prompts/diag-triage.prompt.md`. For adding new device types, use the `new-device-support` skill. Key points:

- Diagnostics archives are encrypted (RSA-4096 + AES-256-GCM); decrypt with `node scripts/decrypt-diagnostics.mjs <file>.tar.gz`
- Always check archive completeness before analysis -- missing runtime logs means the plugin wasn't running
- When diagnostics are incomplete or debug is disabled, ask the user to upgrade to the latest [beta](https://github.com/homebridge-plugins/homebridge-eufy-security/wiki/Special-Version-(BETA---RC---HKSV)) and follow the [Basic Troubleshooting](https://github.com/homebridge-plugins/homebridge-eufy-security/wiki/Basic-Troubleshooting) steps to enable Detailed Logging, reproduce the issue, and re-export diagnostics
- Narrow down whether the issue is in `homebridge-eufy-security` (accessory registration, HomeKit mapping, config handling) or in `eufy-security-client` (device discovery, property events, P2P, push notifications)
- If the environment indicates HOOBS: label `hoobs` + `wontfix` and close -- HOOBS is not supported

### Label recommendations

| Label | When to use |
|---|---|
| `depends on eufy-security-client` | Issue originates in bropat's eufy-security-client library |
| `device-support` | New device type support request |
| `debug log missing` | Diagnostics lack logs or debug mode was disabled |
| `configuration issue` | Problem caused by user config |
| `livestream` | Camera livestream, video feed, P2P, RTSP, streaming failures |
| `question` | Further information is requested |
| `resolved in beta` | Fix already in current beta |
| `needs triage` | New issue awaiting initial analysis |
| `duplicate` | Issue or PR already exists |
| `hoobs` | HOOBS-specific -- label as `hoobs` + `wontfix` and close |

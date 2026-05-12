---
name: support
description: Triage a GitHub issue using diagnostics archives and logs. Use this skill when the user provides a GitHub issue number or URL, says "triage", "diagnose", "look at this issue", "check this bug report", or wants to analyze a diagnostics archive. Handles decryption, log analysis, device identification, root cause narrowing, label suggestions, and drafting issue comments.
---

# Support / Issue Triage

You are a support triage agent for homebridge-eufy-security. Given a GitHub issue, you decrypt diagnostics, analyze logs, identify root causes, and draft user-facing responses.

Refer to CLAUDE.md for label recommendations, issue comment guidelines, and diagnostic triage basics.

## Input

The user provides `$ARGUMENTS` as either:
- A GitHub issue number (e.g. `423`)
- A GitHub issue URL (e.g. `https://github.com/homebridge-plugins/homebridge-eufy-security/issues/423`)

## Step 1 -- Fetch the issue

```bash
gh issue view <number> --repo homebridge-plugins/homebridge-eufy-security
```

Extract:
- What the user reports (symptoms, expected vs actual behavior)
- Device model/type if mentioned
- Plugin version if mentioned
- Whether a diagnostics archive is attached

If no diagnostics attached, draft a comment asking the user to export diagnostics with debug mode enabled and stop.

## Step 2 -- Download and decrypt diagnostics

Download the `.tar.gz.enc` attachment, then:

```bash
node scripts/decrypt-diagnostics.mjs <file>.tar.gz.enc
```

The script prints the archive creation date. Note if the archive is older than 90 days -- data may be stale.

## Step 3 -- Validate archive completeness

List the extracted files and check what's present:

| File | Required for |
|---|---|
| `accessories.json` | All issues |
| `eufy-security.log` | Runtime issues |
| `eufy-lib.log` | Runtime issues |
| `configui-server.log` | UI issues |
| `configui-lib.log` | UI issues |
| `ffmpeg.log` | Streaming/snapshot issues |
| `ffmpeg-<serial>.log` | Per-camera streaming issues |
| `ffmpeg-snapshots.log` | Snapshot issues |
| `unsupported.json` | Device support requests |

**Stop conditions:**
- Runtime logs missing (`eufy-security.log`, `eufy-lib.log`) -- ask user to restart Homebridge, wait for full load, re-export
- Only `accessories.json` present -- archive incomplete, can only confirm device presence

## Step 4 -- Check debug mode

In `eufy-security.log`, check the first lines:
- **Debug ON**: log level `DEBUG`, file/line references (e.g. `platform.ts:311`), logger name includes version (e.g. `[EufySecurity-4.4.2-beta.41]`)
- **Debug OFF**: log level starts at `INFO`, no file/line refs, logger name is just `[EufySecurity]`

Also check config dump for `"enableDetailedLogging":true`.

If debug is disabled, ask the user to enable `Detailed Logging` in plugin settings and re-export. Label `debug log missing`.

## Step 5 -- Extract environment

From the first lines of `eufy-security.log`:
- Plugin version
- eufy-security-client version
- Node.js version
- OS and architecture

**HOOBS check**: If the environment indicates HOOBS (storage path, OS, or user mentions it), label `hoobs` + `wontfix`, comment, and close per CLAUDE.md guidelines.

**Node.js check**: Plugin requires Node.js 20, 22, or 24. If on an unsupported version, note it.

**PKCS1 check**: Node.js 24.5+ has native PKCS1 support -- `enableEmbeddedPKCS1Support` workaround is unnecessary. For Node.js 20/22, the embedded fallback is still needed.

## Step 6 -- Check config for excluded devices

From the config dump in `eufy-security.log`:
- `ignoreDevices` -- serial numbers excluded
- `ignoreStations` -- station serials excluded
- `cleanCache` -- stale accessory pruning

In `accessories.json`:
- `disabled: true` on a station -- its devices won't load
- `ignored: true` on a device -- excluded
- `unsupported: true` -- device type not supported

## Step 7 -- Confirm device presence

Search `accessories.json` for the reported device by type, model, serial, or name. Note: `type`, `isCamera`, `isSmartDrop`, `isLock`, `isDoorbell`, `DeviceEnabled`, `standalone`.

## Step 8 -- Analyze logs

### Runtime issues (`eufy-security.log`)
- Device discovery: search for device name/serial, `register_device`
- Discovery warnings: `[DISCOVERY WARNING]`, `[DEVICE SKIP]`, `[STATION SKIP]`
- Accessory instantiation: `Constructed`, `REGISTER CHARACTERISTIC`, `SEED`
- Service pruning: `Pruning unused service`
- Property events: `Property Changes`, `ON '...`
- Errors: `Error`, stack traces

### Library issues (`eufy-lib.log`)
- Device serial presence -- did the library load it?
- `property changed` events
- Connection/authentication errors
- Push notification handling

### Boundary determination

| Symptom | Layer |
|---|---|
| Device missing from `eufy-lib.log` or API errors | `eufy-security-client` |
| Device loads in library but fails in accessory registration | `homebridge-eufy-security` |
| P2P/push/MQTT failures | `eufy-security-client` |
| HomeKit service wrong or missing | `homebridge-eufy-security` |
| Config not applied | `homebridge-eufy-security` |

### Streaming issues

Check per-camera FFmpeg log (`ffmpeg-<serial>.log`) first -- it isolates that camera's stderr. Look for codec errors, resolution mismatches, connection failures.

If logs are insufficient for livestream issues, consider requesting temporary device sharing:

```
To validate a fix and avoid back-and-forth log exchanges, I'd need to test against an actual <device model> device. Would you be willing to temporarily share your device with the following Eufy account?

homebridge.eufy.sec@gmail.com

Please also let me know which country your account is registered in.

This is entirely optional -- no obligation. I understand sharing device access requires trust. The access would only be used for debugging and can be revoked at any time once testing is complete.
```

## Step 9 -- Cross-reference with code

If needed, read the relevant source to confirm behavior. Use the Architecture section in CLAUDE.md to locate the right files.

## Step 10 -- Produce triage report

Output:

```
## Triage: #<issue-number> -- <title>

### Environment
- Plugin: <version>
- eufy-security-client: <version>
- Node.js: <version>
- OS: <os>

### Root cause
<concise explanation with file:line references if applicable>

### Layer
homebridge-eufy-security / eufy-security-client / configuration issue / inconclusive

### Suggested labels
<comma-separated labels from CLAUDE.md label table>

### Suggested action
<what to do next: fix, upstream issue, request more info, close>

### Draft comment
<user-facing comment ready to post -- formal, concise, first person, simple language, no jargon>
```

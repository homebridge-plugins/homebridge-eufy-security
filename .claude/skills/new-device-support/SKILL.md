---
name: new-device-support
description: Full workflow to add support for a new Eufy Security device type (cameras, locks, sensors, and other devices) across eufy-security-client and homebridge-eufy-security. Covers exploration, implementation, build verification, and git/PR creation.
---

# Add New Eufy Security Device Support

You are adding support for a new device type to the eufy-security ecosystem. The user will provide a GitHub issue URL or device details (model name, model number like T86P2, device type number like 111). They may also provide raw device properties JSON.

Use `$ARGUMENTS` for the issue URL or device details.

## Phase 1 — Gather Information

1. **Fetch the GitHub issue** (if URL provided) to extract: device name, model number (e.g. T86P2), device type number, raw properties JSON, firmware version, and any reference PRs. Note: users on recent eufy-security-client versions see a structured "unknown device" debug message that includes raw properties in a format directly usable with the mapping script.
2. **Check for existing upstream work** — before starting, search for PRs that already add this device:
   ```bash
   gh pr list --repo bropat/eufy-security-client --state all --search "<model> OR <device-type-number>" --limit 10
   ```
   If a PR exists: review its diff to see what's already implemented, what's missing (e.g. missing GenericTypeProperty label, incomplete DeviceCommands), and whether it's merged, open, or stale. If merged, the device may only need homebridge-eufy-security side changes. If open but incomplete, coordinate with the PR author or build on their work. If the PR has review comments, check for flagged issues.
3. **Pre-flight checks** — before proceeding, confirm you have:
   - Device type number (required — cannot proceed without it)
   - Raw device properties JSON (required for accurate property mapping — if missing, ask the user to enable debug logging and re-export diagnostics)
   - Model number / display name (needed for enum naming and documentation)
   - If the device type number is completely unknown (not in any existing code), investigate: check the model number prefix pattern, look at raw properties to infer capabilities (camera properties? lock properties? sensor properties?), and check Eufy's product pages for the model.
4. **Run the pre-implementation audit**: Before writing any code, run the audit script to see what already exists:
   ```bash
   node homebridge-eufy-security/.claude/skills/new-device-support/check-device.mjs <type-number> [--pr-search <model>]
   ```
   This checks all 6 registration points in types.ts, classification methods in device.ts, device-images.js, finds the closest existing devices by property overlap, and searches upstream PRs. Use its output to understand the starting point.
5. **Run the property mapping script**: Save the raw properties JSON to a temp file and run:
   ```bash
   node homebridge-eufy-security/.claude/skills/new-device-support/map-properties.mjs /tmp/<device>-raw-props.json --closest
   ```
   This maps each raw `param_type` to its `CommandType`/`ParamType` enum name, matching property constants, and which existing device types use them. It also outputs a suggested DeviceProperties block. The `--closest` flag ranks existing devices by property overlap to identify the best base device.
6. **Ask the user** two questions:
   - Image naming convention (check if images already exist or need renaming)
   - Enum name for the DeviceType (e.g. `CAMERA_4G_S330`)

## Phase 2 — Plan (use EnterPlanMode)

Create a detailed plan covering all files that need changes. The plan must be based on the actual raw device properties — never guess which properties a device supports.

### Determine device category

Before planning file changes, identify the device category — this determines which classification methods and accessory classes apply:

- **Camera** (including doorbells, floodlights, indoor cameras, solo cameras, 4G cameras): uses `CameraAccessory` in the plugin. Classification methods: `isCamera()`, and optionally `isDoorbell()`, `isFloodLight()`, `isIndoorCamera()`, `isPanAndTiltCamera()`, `isOutdoorPanAndTiltCamera()`, `isSoloCameras()`, etc. Note: `isSoloCameras()` is a composite method that includes outdoor PTZ, wall light cams, and other standalone camera types.
- **WallLightCam**: uses `CameraAccessory`. Classification: `isWallLightCam()`. This category is heavily referenced in `station.ts` (50+ references) for livestream, talkback, property handling, and command routing — expect substantial `station.ts` changes.
- **GarageCamera**: uses `CameraAccessory`. Classification: `isGarageCamera()`. Has dedicated property variants (e.g. `DeviceWatermarkGarageCameraProperty`, `DeviceMotionDetectionSensitivityGarageCameraProperty`). Also has `isGarageCameraBySn()` for serial number matching.
- **Lock** (BLE, WiFi, WiFi Video variants): uses `LockAccessory`. Classification methods: `isLock()`, `isLockWifi()`, `isLockBle()`, `isLockWifiVideo()`, etc. Locks have many specialized type guard methods (e.g. `isLockWifiT8531()`, `isLockWifiR10()`) — check existing patterns carefully. Locks may require changes in **three additional layers** beyond this skill's primary scope — flag these to the user:
  - `src/mqtt/` — MQTT protocol for lock communication
  - `src/p2p/session.ts` — P2P session initialization uses `Device.isLockWifi()` and `Device.isLockWifiNoFinger()` for lock sequence generation
  - `src/http/station.ts` — lock-specific routing at station level
- **Sensor** (entry sensor, motion sensor, PIR sensor): uses `EntrySensorAccessory` or `MotionSensorAccessory`. Classification: `isSensor()`, `isEntrySensor()`, `isMotionSensor()`. Note: `isSensor()` is static-only — no public instance method exists.
- **SmartDrop**: uses `SmartDropAccessory`. Classification: `isSmartDrop()`. Also has `isSmartDropBySn()` for serial number matching.
- **SmartSafe**: no HomeKit accessory currently. Classification: `isSmartSafe()`.
- **Tracker/SmartTrack**: no HomeKit accessory currently. Classification: `isSmartTrack()`.
- **Keypad**: no HomeKit accessory currently. Classification: `isKeyPad()`.
- **WaterFreezeSensor**: no HomeKit accessory currently. Classification: check for `WATER_FREEZE_SENSOR_*` in DeviceType enum.
- **Siren**: no HomeKit accessory currently. Classification: check for `SIREN_SENSOR_*` in DeviceType enum.
- **New category**: if the device doesn't fit any existing category, a new accessory class is needed in `src/accessories/`, a new classification method, and a new `if` block in `register_device()`. Flag this to the user — it's a significantly larger task.

### Files to modify in eufy-security-client

#### `src/http/types.ts` — 6 locations:

1. **DeviceType enum**: Add `ENUM_NAME = <number>, //<model>` in numeric order
2. **GenericTypeProperty `states` field**: Add `<number>: "<Display Name> (<Model>)"` inside the `states` object in numeric order. **WARNING**: This is one of the most commonly forgotten steps. Missing this label causes the device to display as a raw number in downstream UIs (see upstream PR #828 where 5 device types had missing labels).
3. **DeviceProperties**: Add `[DeviceType.ENUM_NAME]` block. Always starts with `...GenericDeviceProperties`. Map each raw param_type to its corresponding `PropertyName.*` property constant. Base on the closest existing device but only include properties that match the raw data.
4. **StationProperties**: Add `[DeviceType.ENUM_NAME]` block if device can act as its own station (solo cameras, integrated devices). Use `...BaseStationProperties` plus station-specific properties.
5. **DeviceCommands**: Add `[DeviceType.ENUM_NAME]` array. Commands depend on device capabilities (livestream, talkback, pan/tilt, download, snooze, preset positions, calibrate, alarm).
6. **StationCommands**: Add `[DeviceType.ENUM_NAME]` array if device has station properties. Typically `[CommandName.StationReboot, CommandName.StationTriggerAlarmSound]`.

#### `src/http/device.ts` — Classification methods:

Add the new device type to all applicable static classification methods. There are two kinds:

**Broad classification methods** (add device to these as applicable):
- `isCamera()` — if it's a camera/doorbell/floodlight
- `hasBattery()` — if battery-powered (critical — omitting this means no battery service in HomeKit)
- `isPanAndTiltCamera()` — if has PTZ
- `isOutdoorPanAndTiltCamera()` — if outdoor PTZ (included by `isSoloCameras()`)
- `isSoloCameras()` — composite method aggregating solo/standalone camera types
- `isFloodLight()`, `isIndoorCamera()`, `isDoorbell()`, `isWallLightCam()`, `isGarageCamera()` — as applicable
- `isLock()`, `isLockWifi()`, `isLockBle()`, `isLockWifiNoFinger()` — if it's a lock variant
- `isSensor()`, `isEntrySensor()`, `isMotionSensor()` — if it's a sensor
- `isSmartDrop()`, `isSmartSafe()`, `isSmartTrack()`, `isKeyPad()` — as applicable

Note: Not all broad methods have public instance counterparts (e.g. `isSensor()` is static-only). Don't create instance methods where none exist for the pattern.

**`isSupported()` check**: After adding to `DeviceProperties` map, `Device.isSupported(type)` automatically returns `true` (it checks `DeviceProperties[type] !== undefined`). This is the foundation of device registration — if `DeviceProperties` entry is missing, the device is silently unsupported regardless of all other registrations.

Add a **new dedicated type guard method** (static + instance pair):
```typescript
static isNewDevice(type: number): boolean {
  //<Model>
  return DeviceType.ENUM_NAME == type;
}

public isNewDevice(): boolean {
  return Device.isNewDevice(this.rawDevice.device_type);
}
```

Update serial number checks if applicable (all are static-only, no instance methods):
- `isIntegratedDeviceBySn()` — add `sn.startsWith("<model>")` if the device is integrated/standalone
- `isSoloCameraBySn()` — add `sn.startsWith("<model>")` if it's a solo camera
- `isSmartDropBySn()` — add if it's a SmartDrop variant
- `isGarageCameraBySn()` — add if it's a garage camera variant
- `isFloodlightBySn()` — add if it's a floodlight variant

#### `src/http/station.ts`:

- `isIntegratedDevice()` — if the device is standalone or can pair as its own station, it may already be covered by `isSoloCameras()`, `isFloodLight()`, etc. Only add explicit check if needed.

#### `src/push/service.ts`:

- If the device is 4G LTE or needs special push notification handling, expand the normalization block (line 768) to include the new type guard.

#### `docs/supported_devices.md`:

Add an entry in the correct table section:
```markdown
| ![<Model> image](_media/<image_small>.png) | <Display Name> (<Model>) | :wrench: | Firmware: <version> |
```
Use `:wrench:` for initial support.

### Files to modify in homebridge-eufy-security

#### `src/platform.ts` — `register_device()`:

Verify the new device type is handled by `register_device()`. This method uses independent `if` blocks (not `else if`) to map device types to accessory classes. If the device is a camera, it falls through to the camera path. If it's a lock, sensor, or SmartDrop, it hits those specific checks. If it's a new category that doesn't match any existing check, the device won't get an accessory — flag this to the user.

#### `homebridge-ui/public/utils/device-images.js`:

Add a case in the `getImage()` switch:
```javascript
case <type_number>: return '<image_large>.png';
```

#### Image assets:

- Rename or add images in `eufy-security-client/docs/_media/` (small + large)
- Rename or add image in `homebridge-eufy-security/homebridge-ui/public/assets/devices/` (large only)

## Phase 3 — Implement

Execute the plan. Key implementation notes:

- **Property mapping**: Use the output from `map-properties.mjs` (Phase 1) as the primary guide. Many property constants have large variant families (e.g. `DeviceMotionDetection*` has 40+ variants, `DeviceFloodlightLight*` has 12+, `DeviceVideoRecordingQuality*` has 11+). When multiple constants match the same `param_type`, pick the variant used by the closest existing device — check the "Used by DeviceTypes" column in the script output and the `--closest` flag results.
- **Companion custom properties**: Some properties have required companions with `custom_*` keys that never appear in raw device data (they're populated at runtime). The script detects these and marks them with `⚠ companion`. Always include them — omitting a companion breaks functionality silently. Key pairs: `DeviceRTSPStream` → `DeviceRTSPStreamUrl`, `DeviceWifiRSSI` → `DeviceWifiSignalLevel`, `DeviceCellularRSSI` → `DeviceCellularSignalLevel`.
- **Insert in order**: When adding to enums, switch statements, or `if` chains, maintain numeric ordering by device type number.
- **Audio recording property**: Different device families use different audio recording property constants (e.g. `DeviceAudioRecordingProperty`, `DeviceAudioRecordingStarlight4gLTEProperty`). Match the closest existing device.

### Registration verification checklist

After implementing all changes, run the post-implementation verification script:
```bash
node homebridge-eufy-security/.claude/skills/new-device-support/verify-device.mjs <ENUM_NAME>
```
This automatically checks all required registration points and reports PASS/FAIL:

1. `DeviceType` enum definition
2. `GenericTypeProperty` states
3. `DeviceProperties` map
4. `DeviceCommands` map
5. `StationProperties` map (if device acts as its own station — reported as WARN if missing)
6. `StationCommands` map (if device has station properties — reported as WARN if missing)
7. Dedicated type guard method (static + instance) in device.ts
8. Broad classification methods (isCamera, isLock, etc.) in device.ts
9. `docs/supported_devices.md` entry (reported as WARN if missing)
10. `*BySn` serial number methods (reported as WARN if missing — not all devices need these)
11. device-images.js case in homebridge-eufy-security

The script exits with code 1 if any required checks fail. A device type that is defined in the enum but missing from DeviceProperties will silently fall back to GenericDeviceProperties with only ~3 basic properties (name, model, serial). This is the most common implementation error — see upstream issue #853 where LOCK_85V0 was added to the enum but never registered in the lookup maps.

## Phase 4 — Build & Lint Verification

Run build and lint for both repos. Note: eufy-security-client lint may fail due to a pre-existing `jiti` library issue unrelated to our changes — the TypeScript build succeeding is sufficient validation.

## Phase 5 — Git & PR

Follow CLAUDE.md Git Workflow for commit messages, branch naming, and PR body format. This skill creates **two PRs** across repos:

### eufy-security-client (cross-fork)

1. Discard unrelated changes (e.g. `package-lock.json`)
2. Sync develop: `git fetch upstream && git checkout develop && git merge upstream/develop`
3. Branch: `git checkout -b feat/<device-slug>`
4. Stage only: images, `src/http/types.ts`, `src/http/device.ts`, `src/push/service.ts`, `docs/supported_devices.md`
5. Cross-fork PR:
   ```bash
   gh pr create --repo bropat/eufy-security-client --base develop \
     --head lenoxys:feat/<device-slug> \
     --title "feat: add <Device Name> (<Model>, type <number>) support" \
     --body-file /tmp/pr-body-<branch>.md
   ```

### homebridge-eufy-security

1. Branch from current beta: `git checkout -b feat/<device-slug>`
2. Stage: `homebridge-ui/public/utils/device-images.js` + any added image
3. PR to current beta branch:
   ```bash
   gh pr create --base beta-<current-version> \
     --title "feat: add <Device Name> (<Model>) image" \
     --body-file /tmp/pr-body-<branch>.md
   ```

### Cross-referencing

After both PRs are created, update both bodies so they reference each other.

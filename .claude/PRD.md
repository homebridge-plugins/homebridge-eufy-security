# PRD -- homebridge-eufy-security

Product Requirements Document for `@homebridge-plugins/homebridge-eufy-security`.

## Purpose

Expose Eufy Security devices to Apple HomeKit via Homebridge. Users control cameras, doorbells, locks, sensors, base stations, and delivery boxes from the Home app -- including live video, HomeKit Secure Video recording, arm/disarm, and two-way audio.

## Target Users

Homebridge users with Eufy Security hardware who want native HomeKit integration without Eufy's official HomeKit firmware (limited or unavailable for most devices).

## System Requirements

| Requirement | Value |
|---|---|
| Node.js | 20, 22, or 24 |
| Homebridge | >=1.9.0 or ^2.0.0-beta |
| Eufy Account | Dedicated guest account (admin accounts blocked) |
| FFmpeg | Bundled via `ffmpeg-for-homebridge` |

---

## Functional Requirements

### FR-1: Device Discovery & Registration

- Connect to Eufy cloud via `eufy-security-client` (cloud API, P2P, push notifications, MQTT)
- Discover stations and devices automatically on plugin startup
- Batch device processing with 10-second debounce to avoid thrashing during sync
- Hot-add/remove devices after initial discovery completes
- Restore cached accessories across Homebridge restarts
- Prune stale cached accessories when `cleanCache: true`
- Devices can stack multiple capabilities (camera + motion sensor + doorbell) via independent registration blocks

### FR-2: Camera Streaming

#### FR-2.1: Live Streaming
- P2P direct stream (default, low latency)
- RTSP stream (opt-in per camera)
- FFmpeg transcoding to H.264 + AAC-ELD with SRTP encryption
- Hardware encoder detection: VideoToolbox (macOS), V4L2 (Raspberry Pi), VAAPI/QSV (Linux)
- Fallback to libx264 software encoding
- Configurable max resolution, bitrate, frame rate
- Max concurrent streams per camera (default 2)
- Configurable livestream duration (default 30s, max 86400s)
- RTCP keep-alive monitoring with inactivity timeout

#### FR-2.2: HomeKit Secure Video (HKSV)
- Record motion/doorbell events as fMP4 fragments
- 4-second segment length (HomeKit requirement)
- 8-second timeshift buffer for pre-motion capture
- Audio recording (AAC-ELD or AAC-LC per HomeKit config)
- Snapshot capture during active recording
- Max 3 segment errors before connection reset

#### FR-2.3: Snapshots
- Four handling modes: AlwaysFresh, Balanced, CloudOnly (default), Auto
- Intelligent caching with configurable thresholds (fresh: 15s, balanced: 30s)
- Placeholder images for offline/disabled/unavailable states
- Cloud snapshot skip within 30s of livestream capture (prevents quality degradation)

#### FR-2.4: Two-Way Audio (Talkback)
- Bidirectional audio via duplex stream
- Caches audio data until device is ready
- 2-second silence auto-stop
- Configurable channel count (mono default)

### FR-3: Security System (Stations)

- Map Eufy guard modes to HomeKit security states (Stay, Away, Night, Off)
- Per-station guard mode mapping (configurable numeric mode values)
- Manual alarm trigger with configurable duration and HomeKit mode filter
- Alarm arm delay and alarm event handling via push notifications
- Multi-station sync via virtual AutoSyncStationAccessory (opt-in)

### FR-4: Locks

- Lock/unlock control via HomeKit LockMechanism service
- Lock jammed state detection via push notifications
- Lock management service (auto-security timeout, admin-only access)

### FR-5: Sensors

#### FR-5.1: Motion Sensors
- Standalone motion detection service
- Camera-integrated motion with configurable timeout
- Multi-event support: person, pet, vehicle, sound, crying, dog, stranger

#### FR-5.2: Entry Sensors (Contact Sensors)
- Door/window open/closed state

### FR-6: Doorbells

- ProgrammableSwitchEvent on ring
- Optional motion-triggers-doorbell mode
- Optional indoor chime control switch
- Snapshot delay on doorbell ring (configurable)

### FR-7: Floodlights

- Lightbulb service for floodlight control
- Combined camera + light capabilities

### FR-8: Smart Drop (Package Boxes)

- One-way open via LockMechanism
- Package delivery detection via ContactSensor

### FR-9: Per-Device Switches

- Enable/disable device switch
- Motion detection toggle switch
- Light control switch (floodlights)
- Indoor chime toggle switch
- All switches individually configurable per camera

---

## Configuration Requirements

### CR-1: Global Configuration
- Eufy credentials (username, password, device name)
- Country code (ISO 3166-1 alpha-2)
- Polling interval (default 10 minutes)
- Global guard mode mapping (hkHome, hkAway, hkNight, hkOff)
- Device/station ignore lists by serial number
- Debug logging toggle (`enableDetailedLogging`)
- Log file opt-out (`omitLogFiles`)
- Cache cleanup toggle (`cleanCache`, default true)
- Auto-sync station mode toggle
- Embedded PKCS1 support toggle (Node.js <24.5 workaround)

### CR-2: Per-Camera Configuration
- Stream source: P2P or RTSP
- Enable/disable camera streaming entirely
- Snapshot handling method (AlwaysFresh, Balanced, CloudOnly, Auto)
- Audio enable/disable
- Talkback enable/disable with channel count
- HKSV recording duration
- Motion timeout
- Per-switch visibility (enable, motion, light, indoor chime)
- Full FFmpeg video config override (codec, resolution, bitrate, filters, encoder options, custom binary path)

### CR-3: Per-Station Configuration
- Guard mode mapping overrides (hkHome, hkAway, hkNight, hkOff)
- Manual alarm trigger modes and duration

---

## Plugin UI Requirements

### UI-1: Device Discovery
- Login flow with TFA and captcha support
- Discovery progress reporting (authenticating, queuing, processing, done)
- Skip button for unsupported device intel wait
- Admin account detection and blocking

### UI-2: Device Management
- Display discovered stations and devices with type, capabilities, power status
- Show unsupported devices separately
- Detect running plugin via heartbeat (accessories.json `storedAt` < 90s old)
- Load stored accessories from cache when plugin is not running

### UI-3: Diagnostics
- Generate encrypted diagnostics archive (RSA-4096 + AES-256-GCM)
- Rate-limited to 60-second minimum between downloads
- Archive includes: config (sanitized), all log files, accessories.json, system info
- Decryptable via `node scripts/decrypt-diagnostics.mjs`

### UI-4: Storage Management
- Reset plugin storage (persistent.json, accessories.json)
- Clean all storage option
- System info endpoint (plugin version, Node.js version, host OS)

---

## Non-Functional Requirements

### NFR-1: Logging
- Rotating file streams (daily rotation, max 3 archives, 200MB limit)
- Styled console output (color-coded by level)
- Debug mode adds file:line references and library-level logging
- Separate log streams: plugin, library, UI server, UI library, FFmpeg (global + per-camera + snapshots)

### NFR-2: Reliability
- Connection retry (3 attempts, 30s backoff) on Eufy cloud failure
- P2P stream retry with exponential backoff (2-10s, max 3 attempts, 15s timeout per attempt)
- Multi-consumer stream sharing via reference counting (streaming, recording, snapshots share one P2P connection)
- 5-second grace period before stopping shared P2P stream
- Node.js MaxListeners raised to 30 for multi-camera setups
- fMP4 box validation (max 50MB per box) during HKSV recording

### NFR-3: Compatibility
- ESM module (`"type": "module"`, `"module": "NodeNext"`)
- TypeScript strict mode, ES2022 target
- PKCS1 padding workaround for Node.js 20/22 (restored natively in Node.js 24.5+)
- Hardware codec probing at startup with graceful software fallback

### NFR-4: Security
- Encrypted credential persistence (never logged)
- Guest account enforcement (admin account usage blocked)
- TFA/captcha graceful handling with shutdown and re-auth prompt
- Diagnostics archives encrypted before export

---

## Architecture Boundaries

### homebridge-eufy-security (this plugin)
- Accessory registration and HomeKit service mapping
- FFmpeg transcoding pipeline
- Configuration handling and validation
- Plugin UI (device discovery, diagnostics, storage management)
- accessories.json persistence for UI communication

### eufy-security-client (upstream dependency)
- Eufy cloud API authentication and communication
- P2P connection establishment and stream management
- Push notification and MQTT event handling
- Device type classification and property management
- Command execution (arm/disarm, lock/unlock, etc.)

Issues must be triaged to the correct layer. The plugin communicates with the library via events (`station added`, `device added`, `property changed`, push events) and commands.

---

## Device Type Coverage

| Category | HomeKit Services |
|---|---|
| Cameras | CameraRTPStreamManagement, MotionSensor, optional Switches |
| Doorbells | Doorbell + Camera services, ProgrammableSwitchEvent |
| Floodlights | Camera + Lightbulb services |
| Base Stations | SecuritySystem (arm/disarm), optional manual alarm Switch |
| Smart Locks | LockMechanism, LockManagement |
| Entry Sensors | ContactSensor |
| Motion Sensors | MotionSensor |
| Smart Drop | LockMechanism (open-only), ContactSensor (package detect) |
| Video Locks | Camera + Lock services (LockWifiVideo) |
| Auto-Sync Station | Virtual SecuritySystem syncing multiple stations |

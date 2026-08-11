# V5 plan — adversarial review findings (2026-08-06)

Reviewers: opencode `azure/gpt-5.6-sol` (primary), cross-checked by `gpt-5.6-luna` and
`gpt-5.6-terra`. Every finding below was **independently re-verified against SDK source** by reading
the cited lines; reviewer claims that did not survive that check are listed at the bottom as rejected.

Status: SDK media pass IMPLEMENTED and merged in eufy-sdk PR #9. The required SDK build is published
privately as `0.1.0-beta.6` on GitHub Packages for the maintainer pilot. Mapper review landed; its
registry redesign is recorded below.

---

## Confirmed: `recordFragments()` cannot carry HKSV as-is

Four independent defects, all verified in source.

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| 1 | **Video-only output** | `command-router.ts:684` registers `consumer.on("video")` only. `fmp4.ts:142` `moov` = single `trak()`, no `mp4a`/`soun` | HKSV mandates AAC-ELD. Clips would have no audio track at all |
| 2 | **No prebuffer** | `shared-live-source.ts:237` `lastKeyframe` = ONE frame, primed at `:308`. Real ring exists at `:436` but `preBufferMs = (preBufferSeconds ?? 0)*1000` → 0, and `recordFragments` never forwards the opt nor drains the ring | Clip starts at the IDR nearest the request, i.e. after the event |
| 3 | **No HAP config negotiation** | `contracts.ts` sig = `{fragmentSeconds, powered}`. No resolution/bitrate/profile/level/audio codec. `fmp4.ts:220` copies the camera's own SPS profile+level; emits `hvc1` for H.265 | HomeKit gets media it did not negotiate; H.265 camera → rejected |
| 4 | **Budget truncates recordings** | Budget applies to every egress, but `recordFragments` registers only video/stop/error. Returns bare `AsyncIterable<MediaFragment>` — no handle to extend on. Talkback DOES forward `budget`; recording does not | Battery camera recording dies at ~55s mid-event |

Secondary, same area:

- **`fragmentSeconds` is a MINIMUM, not a guarantee** (`fmp4.ts:25-29`, boundary logic `:91-98`).
  A fragment closes only on a keyframe once the minimum is reached; no time-only split. Long-GOP
  camera → oversized, late first fragment. Docs oversell this as "or every fragmentSeconds".
- **`openReadable({audio:true}) produces a corrupt stream`** (`readable-egress.ts:55`) — pushes raw
  audio buffers into the same Readable as Annex-B video bytes. Undemuxable. Broken for every
  consumer, not just HomeKit.
- **Inbound audio has no codec metadata.** `LiveVideoFrame` carries `codec`; audio is a bare
  `Buffer` (`contracts.ts:240`). **This is a regression vs ECS**, which gave us
  `StreamMetadata.audioCodec` (V4 used it in `applyP2PAudioFormat()`). No consumer can transcode blind.

### The reframing that changed the decision

These are **half-built SDK features, not missing ones**:

- the shared source **already** emits audio to consumers (`shared-live-source.ts:206`) — the muxer
  just ignores it;
- `ringBuffer()` **already exists**, and its docstring literally reads *"Drain the rolling pre-buffer
  (V5) … The host decides when to drain (e.g. on a motion event)"* (`shared-live-source.ts:433`).
  It is reachable only from a unit test;
- `preBufferSeconds` **already** reaches `live()` (`command-router.ts:481` passes opts through) but
  `recordFragments` drops it (`:669`).

So the plan assumed plumbing that was never finished, rather than inventing a capability.

---

## Decision (taken with user, 2026-08-06)

**SDK media pass in `beta-0.1.0` FIRST, then HKSV stays in plugin 5.0.**

Rationale — repo split rule, *eufy-truth → SDK, HomeKit representation → plugin*. Each item below
benefits every SDK consumer (HA bridge, go2rtc, any NVR-shaped host), not just Homebridge:

### SDK work (`eufy-sdk`, branch `beta-0.1.0`)

Implementation status: **complete in merged PR #9 and published as `0.1.0-beta.6`**. The SDK boundary
keeps shared media primitives in the SDK.

1. **[complete] Typed inbound audio codec** — `contracts.ts` audio listener gains codec metadata. Closes an
   ECS regression; nothing can transcode without it.
2. **[complete] Audio track in `Fmp4Muxer`** — `fmp4.ts` gains an `mp4a`/`esds` trak; `command-router.ts`
   `recordFragments` subscribes to `consumer.on("audio")`.
3. **[complete] Prebuffer drain** — `recordFragments` forwards `preBufferSeconds` and drains `ringBuffer()`
   into the muxer ahead of live frames, with timestamp continuity.
4. **[complete] Budget on the recording handle** — expose budget notices so a caller can `extend()` while an
   event recording is still owned by the host.
5. **[complete] `openReadable({audio:true})`** — the corrupt audio option is removed; raw readable
   output is explicitly video-only.
6. **[complete] Docs** — `live-media.md` states `fragmentSeconds` is a keyframe-bounded minimum and
   documents prebuffer, audio, and recording-budget behavior.

### Plugin work (stays in `homebridge-eufy-security`)

- HAP `CameraRecordingConfiguration` enforcement: profile/level/bitrate/resolution/GOP cadence
- AAC-ELD encode (HAP's codec, not eufy's)
- H.265→H.264 transcode decision (SDK states truth via `frame.codec`; plugin picks the target)
- SRTP/RTP packaging, RTCP keep-alive + initial grace, RECONFIGURE ack, placeholder images

### Consequence for the plan

Plugin **step 6 (HKSV) can target `0.1.0-beta.6` for the private maintainer pilot**. Steps 1-5, 7, 8
are unaffected and can proceed. Full parity for 5.0.0 is retained as the target.

---

## Corrections to the original plan (apply before coding)

- **Live stream must use `cam.live()`, not `openReadable()`**, and feed video + audio to ffmpeg as
  two separate inputs — V4 did exactly this (`streamingDelegate.ts` separate video/audio processes,
  with an 8s audio-stall timeout so a silent camera cannot block video). `openReadable`'s audio
  interleave is unusable.
- **Live SRTP path must keep** RTCP keep-alive monitoring + `STREAM_INITIAL_GRACE_MS`, RECONFIGURE
  acknowledgement (V4 ack'd and ignored it — parity means ack, not implement), snapshot-during-stream,
  and hardware-encoder probing. The plan silently dropped all four.
- **Talkback is an adapter, not a pipe.** One ffmpeg transcode to AAC-LC 16 kHz mono ADTS, bitrate
  configured so frames stay under `MAX_AUDIO_FRAME_BYTES = 640` (`adts.ts:50`). SDK's 30s idle
  timeout ≠ V4's 5s — that is a product decision, not a silent deletion.
- **Prebuffer scope is narrower than feared**: V4's own `CameraAccessory` sets `prebufferLength: 0`
  when `hasBattery()` or RTSP. The gap only affects **wired** cameras.

## Dependency math — measured, replaces the plan's estimate

```
V4 prod packages (master lockfile):  133
V5 prod packages (current lockfile):  94      -39  (-29%)
direct deps:                        7 -> 3
```

werift is present (6 paths) and the tree still shrinks. The "weight just moved behind one name"
concern does not survive measurement.

## Private pilot dependency, independent of all the above

Public npm `@mega-yfue/eufy-sdk@0.0.5` remains an empty scaffold. The usable SDK is now published as
**GitHub Packages `0.1.0-beta.6`** from the `beta-0.1.0` branch, and the plugin pins that exact version.
This distribution is intentionally limited to the maintainer's private pilot. The maintainer setup
needs `@mega-yfue:registry=https://npm.pkg.github.com` and a classic token with `read:packages`; those
credentials are not a public plugin installation contract.

---

## Reviewer A (IPC / deps / guard mode) — landed 2026-08-06

Ran to completion on sol. 11 findings. Two of its three BLOCKERs are already answered by the
UI-owns-login redesign; the third is a measurement artifact. What survives:

### Answered by the redesign (do not re-raise)

- **#1 "Plugin disabled → UI has no socket → no way to authenticate."** Verified real
  (`homebridge/dist/server.js:440-476` skips a disabled plugin before constructing the platform) —
  and it is the same defect as "no config block on first install". The UI owning the only
  interactive login closes both. The plan no longer claims the plugin "always starts".
- **#4 "Socket carries email/password/captcha unauthenticated."** The socket no longer carries any
  of them. Reduced to `devices` / `release` / `reload`.

### Survives — must be carried

| # | Sev | Finding | Owner |
|---|---|---|---|
| 3′ | AMENDMENT | **werift is ~20 of the 36 added packages** and the plugin uses P2P, not WebRTC | **SDK** |
| 7 | AMENDMENT | `log.debug` is off by default (`homebridge/dist/logger.js:27-31`, early-returns at `:104-110`) — passing the logger straight in silently swallows every SDK diagnostic for normal users | plugin |
| 8 | AMENDMENT | dropping `rotating-file-stream` loses V4's **per-camera ffmpeg** log files (`master:src/utils/utils.ts:141-199`); Homebridge console logging is not equivalent | plugin |
| 9 | AMENDMENT | `validValues` is **not proven** to hide Night in iOS Home. HAP enforces it server-side (`Characteristic.js:1988-1994`) and publishes `valid-values` (`:2287`), but nothing specifies rendering. Mark UNVERIFIED until tested on a paired phone | plugin |
| 10 | AMENDMENT | V4 Night automations **hard-fail** — HAP rejects target `2` before the setter runs; no fallback to Stay/Away. Needs an explicit migration warning | plugin |
| 5 | AMENDMENT | stale-socket / lifecycle state machine: bounded connect+response timeouts, `ECONNREFUSED`/`ENOENT` → "plugin unavailable", probe-then-unlink before bind, and a `ready` reply so "socket bound" ≠ "SDK initialised" | plugin |
| 2 | RISK | child bridges / two platform instances. `singular: true` bounds it to one block, but confirm a child-bridge fork does not double-construct | plugin |
| 11 | RISK | cached accessory + shrinking `validValues` needs **no** purge — `setProps` overwrites restored props (`Characteristic.js:1482-1492` vs `:2317-2330`). Reviewer explicitly says do not prescribe a blind cache purge | plugin |

### Rejected — measurement artifact

**#3 BLOCKER "dependency reduction is false: 134 → 227 production nodes."** Wrong, and the cause is
our own known-broken state (task #14). `node_modules/@mega-yfue/eufy-sdk` is a **symlink to the SDK
working tree**, so `npm ls --parseable` walks into the SDK's own *dev* install — the 227 includes
`vitest`'s transitive tree (`chai`, `assertion-error`, `@babel/runtime`, `convert-source-map`…).
The SDK declares exactly `mqtt`, `protobufjs`, `werift` as dependencies.

Lockfile-based count, which is authoritative:

```
V4 master        133 prod nodes / 132 unique
V5 beta-5.0.0     94 prod nodes /  91 unique      -39
removed 77, added 36
```

The reviewer's underlying *point* is still right though: of the 36 added, ~20 are werift/WebRTC
(`@peculiar/*`, `@fidm/*`, `@noble/*`, `dns-packet`, `multicast-dns`, `tsyringe`, `mediabunny`…)
for a path the plugin never takes. That is an **SDK packaging** issue, not a plugin one.

Lesson for the next measurement: never count deps through a symlinked workspace.

## Rejected reviewer claims (did not survive verification)

- *"The plan is wrong to say don't pass the `powered` hint."* — It is not. `camera.ts:302`
  `poweredOf(ctx)` derives it from `has("battery")` and the capability wrapper injects it on every
  media call. Plugin correctly passes nothing.
- *"Dependency reduction is false (134 → 227)."* — symlink artifact, see above. Real figure 133 → 94.

---

## Generic mapper review — landed 2026-08-06. The premise does not survive.

Two narrowed sol runs (B1 vocabulary sufficiency, B2 bundles/enums). Both say the same thing from
different angles: **the manifest cannot determine HomeKit shape, and the mapper is a typed registry
with a generic execution engine around it — not a generic mapper.**

### B1 — vocabulary is insufficient

- `contact.open` is `type: "bool", kind: "boolean"` (`contact.ts:108-115`) — *identical* to
  `leakDetected` (`leak.ts:19-27`), `smokeDetected` (`smoke.ts:19-24`), `coDetected`
  (`co.ts:19-24`), charging, config toggles, test mode, solar history. Only `cap.capability`
  separates `ContactSensor` / `LeakSensor` / `SmokeSensor` / `CarbonMonoxideSensor`. **That is a
  capability-name lookup table — precisely what the plan claimed to avoid.** Say it plainly.
- HAP polarity is inverted for contact (`open=true` → `CONTACT_NOT_DETECTED=1`) and **the SDK knows
  this**: `invert` exists on members but `readDescriptor` does not export it
  (`manifest.ts:149-161`). Every consumer is forced to re-hardcode a fact the SDK already holds.
- `Service.Battery` needs `StatusLowBattery`; the manifest has `level` (`battery.ts:142-150`) and
  `charging` (`battery.ts:156-168`) only. `batteryAlert` is an event *name* with no typed payload
  (`manifest.ts:81-83`). V4 read `DeviceBatteryLow` / `DeviceBatteryIsCharging` directly
  (`master:src/accessories/Device.ts:42-75`). The threshold is plugin policy.
- **`motion.ts` exposes configuration reads but no `motionDetected` read** (`motion.ts:460-661`),
  while V4 mapped a semantic motion property (`master:src/accessories/MotionSensorAccessory.ts:34-45`).

### B2 — six hand-written exceptions, not two

1. `CameraController` · 2. `SecuritySystem` · 3. `LockMechanism` · 4. `GarageDoorOpener` ·
5. doorbell `StatelessProgrammableSwitch` bundle · 6. manual-alarm / siren trigger

- **`reflects` names one read on the same capability** (`types.ts:312-316`). It cannot express a
  target/current pair, optimistic target persistence, or convergence. And a read straight after a
  write returns the previous value for up to a minute (`docs/events.md:56-57`). Lock actuation is
  worse: `lock()`/`unlock()` are momentary methods with no `reflects` at all (`lock.ts:152-165`),
  and the only read is a boolean `locked` (`lock.ts:108-124`) — no JAMMED, no UNKNOWN.
- **Arming enum values collide head-on with HAP.** SDK `0=away, 1=home, 2=schedule, 3=custom1, …,
  63=disarmed` (`arming.ts:100-110`) vs HAP `0=STAY, 1=AWAY, 2=NIGHT, 3=DISARMED`. Every integer is
  wrong. TRIGGERED is not a mode at all — it arrives as an alarm event (`arming.ts:339-343`). V4
  carried explicit bidirectional tables (`StationAccessory.ts:172-185, 256-279`).
- **Momentary → `StatelessProgrammableSwitch` is backwards.** That service *emits* physical-input
  events; it does not accept a SET. V4 used a plain `Switch` with explicit reset and event-driven
  resync (`StationAccessory.ts:111-117, 361-408, 244-245`). Mapping to `Switch.On` without a reset
  leaves it stuck ON — exactly the failure the plan hand-waved.
- Manifest has no service subtype / instance identity (`manifest.ts:67-84, 86-101`). V4 sidestepped
  it with one `PlatformAccessory` per door, `doorId: 1 | 2` (`GarageDoorAccessory.ts:10-25`).
  Reviewer flags that `enableDoor1`/`door1Name` are **not** in that file — my earlier claim was
  wrong, UNVERIFIED where they actually live.

### What this changes

The mapper stays worth building — a typed registry plus a generic engine still beats 8 accessory
classes — but the plan's LOC estimate and its "two exceptions" claim are both wrong. Rewrite step 2
around an explicit per-capability table, and stop calling it generic.

### SDK asks it produces — filtered through the boundary rule

A gap is the SDK's only if it is eufy-truth and serves every consumer. Passing:

- **`motionDetected` read missing** — a device-truth reads gap, same class as any other missing read.
- **`invert` not exported on `ReadDescriptor`** — the SDK holds the polarity and withholds it.
- **lock has no JAMMED / UNKNOWN** — device truth, if the wire carries it (verify before filing).

Not the SDK's, do not file: HAP enum domains, `StatusLowBattery` threshold, service bundling,
subtype identity, target/current persistence. All HomeKit representation.

## Superseded — the open questions this review answered

The `describe()`-driven mapper (replacing 8 accessory classes / 2106 LOC with ~700 LOC) has **not**
been adversarially reviewed. Three attempts timed out mid-exploration. Decision taken: re-run as
three narrowed sol reviews, briefs written at `/tmp/octo-rev-B1.md` (vocabulary sufficiency for
sensors), `/tmp/octo-rev-B2.md` (enum domains + multi-characteristic bundles + subtypes), and a
third still to write (honest LOC estimate + hybrid verdict).

Open sub-questions worth carrying regardless:
- `leak`/`smoke`/`co` are three identical booleans mapping to three different HAP Services — if the
  mapper switches on `cap.capability`, it is a lookup table, which is what the plan claimed to avoid.
- `ContactSensorState` is INVERTED vs a boolean `open` (CONTACT_DETECTED=0).
- `StatusLowBattery` is a threshold the SDK does not provide — who picks it?
- HAP enum integers (LockCurrentState, CurrentDoorState, SecuritySystemCurrentState) almost certainly
  do not match SDK enum values → per-capability translation tables.

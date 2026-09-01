# Architecture

V5 separates verified Eufy device truth from HomeKit policy and keeps one long-lived owner of the SDK
session. Its architecture is a closed graph of modules rather than a set of feature-specific paths to
the SDK.

## Runtime flow

```text
@mega-yfue/eufy-sdk
  -> persisted SDK adapter
     -> RuntimeOwner
        -> current runtime state
        -> versioned canonical registry view
        -> allowlisted persisted device snapshot
           -> custom UI and diagnostics
        -> HomeKit reconciler
           -> explicit capability and bundle adapters
              -> HomeKit services, characteristics, controllers, and media consumers
```

`RuntimeOwner` is the only long-lived SDK owner. It validates that a complete registry and its snapshot
contain the same entity serials, persists and publishes the snapshot, installs the registry view, and
only then enters `ready`.

The registry and runtime state are separate interfaces. The latest complete registry is retained while
the runtime is degraded, requires authentication, fails, stops, or is stopped so that a temporary
connection failure cannot mutate HomeKit topology. Runtime state determines whether operations are
currently available. A later complete inventory is the only input that may replace the view and
withdraw capability evidence.

Connectivity loss moves availability to `degraded`; a later connection schedules complete discovery,
and only successful complete publication restores `ready`. Session expiry, startup failure, process
signals, and Homebridge shutdown converge on one idempotent cleanup. Cleanup detaches SDK listeners,
bounds disconnect and lease release against one deadline, and never releases an acquired lease more
than once. Successful release finalizes the tracker inside the ownership guard after removing the old
owner and before a successor can acquire. A timeout still attempts the remaining cleanup and publishes
`failed` rather than leaving active runtime evidence behind.

Consumers can read the current registry view and subscribe to later complete versions. HomeKit defines
the minimal source interface it consumes; the platform composition root injects the structurally
compatible `RuntimeOwner`. HomeKit does not import or construct the runtime implementation.

The HomeKit reconciler keys accessory containers from the historical device UUID input `d1_<serial>`.
Routing facts and discovery order never participate in identity. An explicit primary-purpose adapter
must attach before a container is published; supplemental identity metadata can enrich that container
but cannot establish representation. Services use stable semantic adapter keys within the container.

## Module graph

```text
src/
  account/       account lease, persisted generations, temporary authentication
  device/        complete discovery and allowlisted snapshot vocabulary
  homekit/       coverage matrix, reconciler, explicit capability and bundle adapters
  media/         FFmpeg, live sessions, recording, talkback, and snapshot adaptation
  runtime/       long-lived owner, SDK adapter, canonical registry, status tracker
  ui/            snapshot dashboard projection and Homebridge custom UI composition root
  configuration.ts
  platform.ts    Homebridge runtime composition root
  settings.ts
  storage.ts     stable persistence root and pre-rename V5 migration
  index.ts       package entry and platform registration only
```

Dependencies follow these directions:

| Source        | Allowed internal dependencies                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `device/`     | None                                                                                                        |
| `account/`    | configuration, device                                                                                       |
| `runtime/`    | account, configuration, device                                                                              |
| `media/`      | configuration, device                                                                                       |
| `homekit/`    | device, plus type-only imports from `media/contracts.ts`                                                    |
| `ui/`         | account, configuration, device, HomeKit admission policy, media retention, persisted runtime views, storage |
| `platform.ts` | configuration, runtime, HomeKit, media, storage                                                             |
| `index.ts`    | platform and settings                                                                                       |

V5 state lives under `homebridge-eufy` in the Homebridge storage directory. `storage.ts` atomically
adopts the earlier `eufy-security` V5 directory only when no live SDK owner holds it. If both roots
exist, startup fails rather than guessing which account generation is authoritative.

The contract suite rejects unlisted top-level modules, dependency edges, internal cycles, generic
sharing buckets, and internal barrels. A new module or edge is an architecture decision and therefore
requires a deliberate update to both this document and the executable contract.

Each HomeKit capability adapter is self-hosted in one file: its admission evidence, coverage rows,
stable keys, HAP attachment, observations, events, and diagnostics stay together. The adapter registry
only assembles those modules; the reconciler owns containers and complete-snapshot lifecycle, not
capability behavior.

`device/member-evidence.ts` indexes the typed members in one SDK manifest without assigning HomeKit
meaning. Adapters declare exact semantic requirements, and the reconciler admits them through that
shared evidence seam before attachment. Primitive shape alone never selects an adapter.

## Composition roots

`platform.ts` and `ui/server.ts` are composition roots. They may see multiple modules to construct and
connect them, but they contain no domain behavior.

The runtime composition root connects account persistence, ownership, the long-lived SDK adapter,
registry publication, HomeKit reconciliation, and media adapters. The UI composition root connects the
temporary authentication owner to account stores, clears account-bound retained images only after a
successful account replacement, and reads allowlisted persisted runtime views. Its dashboard projection
consumes the same closed HomeKit adapter registry used by reconciliation,
so the browser receives recognized, represented, and controllable summaries without reconstructing the
SDK capability model.

Device-tile product artwork is synchronized from the SDK documentation gallery by
`scripts/sync-device-artwork.mjs`. The packed UI ships that local copy and never fetches product images
at runtime. Exact model images use the SDK gallery's product-line and model-code names; an unavailable
image reveals the tile's local category fallback.

Only `runtime/sdk-client.ts` and `ui/server.ts` may construct a concrete SDK client. Other modules may
consume public typed SDK capabilities relevant to their policy, but may not import SDK transports,
private package paths, or the client facade.

## Module design

Interfaces live beside the consumer that needs them. The exception is the domain-owned type-only media seam
in `media/contracts.ts`, which is defined once because both HomeKit and concrete media adapters must use the
exact negotiated contract. Implementations are injected at a composition root. This keeps each interface
small and prevents a generic contracts layer from becoming a second dependency hub.

Generic `common/`, `contracts/`, `shared/`, and `utils/` directories are forbidden. Shared behavior
belongs to the domain that owns its invariant. Internal barrels are also forbidden; the package entry
point and closed registries such as the capability adapter registry are deliberate exceptions.

Behavior is tested through public module seams in `test/contracts/`. Tests stay independent from
private helper structure and use synthetic typed SDK fakes, real HAP definitions where relevant, and no
account or network access.

`diagnostics.ts` also owns support archive collection and encryption. It reads only its fixed log and
reproduction-marker paths, snapshots the exact evidence shown in a versioned review manifest, and
permits one export of that reviewed snapshot. The UI receives evidence only as an RSA-OAEP-wrapped,
AES-256-GCM encrypted envelope; it has no plaintext evidence export or upload route.

### FFmpeg attribution

An adaptation failure names the build it came from and what that build did, because neither is inferable
from the host facts alone: a bundled static build and a distribution build on the same host advertise
entirely different encoder sets, and one shared failure reason makes every cause read as the same fault.

Three separate mechanisms carry it, and they stay separate because they answer different questions.

- **Which binary.** `configuration.ts` decides whether a resolved path is the bundled build or one an
  administrator configured, by comparing it with the bundled one rather than remembering which branch
  produced it — the plugin serializes the resolved path back as an explicit setting, so the branch is
  not durable. `media/live-stream.ts` reads that binary's own version banner, because whether it answers
  at all is what separates a wrong path from a missing encoder. `diagnostics.ts` persists the result
  under its own storage root and republishes it as environment evidence, since the process that resolves
  it is not the one that assembles an archive. `runtime/sdk-client.ts` hands the same resolved path to
  the SDK, whose own media paths shell out to decode a live snapshot and otherwise look the bare name up
  on `PATH`. One resolution therefore serves every media path: a host with no system FFmpeg would
  otherwise stream and record from the resolved build while its stills failed against a binary that is
  not there, and the reason a decoder that cannot run reports is the one the SDK declares non-retryable.
- **What the process did.** `media/contracts.ts` owns the bounded adaptation vocabulary. A spawn
  failure, an exit before first output, and an exit after output began are separate live-session
  reasons, because the same exit status means opposite things either side of first output. A process
  that ended as its session intended is reported too, without a reason, when it wrote diagnostics of its
  own — a build that warns its way through a working session is what an unwatchable-live-view report
  needs.
- **What it said.** Every adaptation process retains a bounded tail of its own stderr, which is the
  only place an encoder-level cause is stated. `diagnostics.ts` is the sole gate on that text: the
  record's role, event, exit status, and signal are checked against its own allowlists, and each line
  has URLs, key material, filesystem paths, addresses, and device serials replaced before it is kept,
  because this plugin's argument list carries the SRTP key and the controller address and an SDK
  snapshot filename carries a serial. Key material is replaced before the path rules run: base64
  includes `/`, so a path rule applied first splits a key into fragments too short for any length
  threshold to catch. The SDK's own FFmpeg output, forwarded under an `[ffmpeg]` prefix, is recorded
  through the same gate.

Those records are the `ffmpeg-log` evidence class the `live-media` and `hksv-recording` profiles
declare, so they are retained only while a profile declaring them is authorized.

## Ownership boundaries

- The SDK owns verified device capabilities, observations, operations, events, and transport behavior.
- The plugin owns Homebridge lifecycle, accessory identity, HomeKit representation, configuration,
  diagnostics, and media adaptation.
- A missing SDK fact is an SDK gap and is never guessed in the plugin.
- Partial inventory updates change included evidence only. Only a complete snapshot may withdraw
  capability evidence.
- Successful command delivery is not a physical device observation.
- The runtime registry is the only in-process source of operational SDK devices.
- The persisted snapshot is an allowlisted read model for UI and diagnostics, not a second operational
  registry.
- Maintainer acceptance tooling under `scripts/` may deliberately open a second SDK owner, against a copy of
  the persisted storage root so it cannot rotate or stage the records a running plugin owns. That is a
  qualification path, never a runtime one: nothing in `src/` may take that shortcut, and the one tool that
  writes to a device is excluded from the published package.
- Qualifying the refusal of a second owner is the one case that must target the live storage root, because a
  copy holds no live lease and so cannot demonstrate refusal at all. Such a tool may attempt an ownership
  lease and nothing else: it constructs no SDK client, and it writes only the bakery-guard record its own
  attempt requires. Opening a second SDK owner still requires a copy.

## Media boundary

Media adaptation is a separate plugin module because source acquisition and HomeKit output have
different contracts and lifetimes. The SDK supplies Eufy source truth. `media/` owns FFmpeg, negotiated
output, snapshots, live sessions, talkback, HKSV fragments, prebuffer, and resource budgets.

`media/contracts.ts` defines the type-only interface shared by HomeKit camera bundles and concrete media
adapters. HomeKit may import only that file from `media/`; the platform composition root injects the concrete
implementations. This gives negotiation, source, lifecycle, and output vocabulary one owner without allowing
camera adapters to depend on FFmpeg implementations or embed independent process and cleanup policies.

A process shutdown stops active media but does not remove a configured camera controller. Removing the
controller is reserved for genuine capability or accessory withdrawal because HAP treats removal as a factory
reset and deletes the controller-selected recording configuration.

A live session is bounded by whichever domain owns the phase. The SDK owns source warm-up: it retries a
start inside its own window and fails its consumers with a typed error, which the plugin already
subscribes to, so that error is the primary failure signal for a source that never produces video. The
plugin's own start bound is therefore a backstop set strictly above the SDK's window, and exists only to
catch an SDK that reports nothing at all. A shorter plugin bound would truncate the SDK's retries and
tear the source down before its explanation arrived, converting a diagnosable transport failure into a
silent local timeout. For the same reason RTCP liveness is armed when adaptation first reaches the
negotiated output rather than when the session starts: before media flows the backstop owns the bound,
and an absolute grace would fail a source that legitimately warms for longer than one RTCP interval.
Each failure reports one bounded reason through the HomeKit diagnostic seam, so `media/` reports outcomes
without importing diagnostics.

### Prepared session lifetime

A prepared live session is bounded by the controller's HAP connection rather than by a plugin timer.
`SetupEndpoints` must answer with the accessory's ports before the controller decides whether to start, so
the video reservation, and the audio one when audio is negotiated, are made during preparation and
necessarily outlive that answer. Reserving them at start instead is not available: the answer has to carry
ports the plugin already owns. HomeKit ends a session that was set up but neither started nor ended only
when its HAP connection closes; neither the protocol nor the accessory bounds that gap, and the gap itself
belongs to the controller, so nothing observable from this side can say how long a legitimate one is.

The plugin therefore holds the reservation for exactly as long as HomeKit still reports the session as set
up. No SDK handle, adaptation process, or device session exists in that window, so an idle prepared
session costs one or two UDP ports and one of the accessory's two stream management services, and a
controller that negotiates and only later starts still finds a valid answer. Releasing on a plugin timer
would need a duration for the negotiate-to-start gap that no available observation supports, and choosing
such a duration by guesswork is what truncated the SDK warm-up window once already. The failure it would
cause is not a silent one: a start for a session the plugin has released is refused, either by the
accessory when the release also force-stopped the session or by the delegate when it did not, and HomeKit
closes the session on that error and renegotiates. So the cost of a wrong duration is a lost negotiation
rather than a session answering on nothing, and that cost has no upside while the reservation holds
nothing but ports. Two abandoned preparations on one connection do leave that camera unable to negotiate
until the connection closes; that consequence is recorded here instead of being hidden behind a timer.

What the plugin does owe is one release path. A stop request, a force-stop after a video failure, a failed
stream request, and adapter detachment all release the same recorded session exactly once, and a
preparation that completes after its session was cancelled or replaced releases its own reservation
immediately. A session HomeKit has ended is not retained, so a later request for it is refused before it
can reach stopped media.

The last successful image is plugin state rather than SDK state. The SDK retains a stored-only image
only in memory for the lifetime of its session, so a restart or a cold camera would otherwise leave
HomeKit with no image at all. `media/` therefore retains one validated source JPEG per camera under
`homebridge-eufy/snapshots`, using an opaque serial-derived name, directory mode `0700`, file mode
`0600`, and temporary-file-plus-rename replacement. The location makes the images part of a full
Homebridge backup while the 10 MiB validation bound keeps a retained image inside the Homebridge UI
per-file backup limit; the allowlisted diagnostics archive never reads plugin storage, so support
evidence cannot contain camera imagery. Retained provenance and its acceptance time stay in memory, so
a restored image is treated as the oldest acceptable fallback.

A snapshot requested while a live session is streaming is served by the snapshot policy that camera
already has, and changes nothing about the session. The two acquisitions are separate consumers of one warm
SDK source rather than competitors: the retained-image and stored policies do not touch the source at all,
and a live still shares the source the session is already using. Measured on the wire, a snapshot taken
mid-session leaves the session's synchronisation source, its SRTP key, its in-use status, and its single
adaptation process unchanged, whether it was answered from the retained image in milliseconds or acquired
live in about eight seconds. Live view therefore never has to be interrupted to answer a snapshot, and a
snapshot that fails does not end a session.

A camera an admitted observation reports as disabled is presented rather than photographed: the plugin serves
a packaged disabled image, attempts no acquisition at all, and keeps but never serves that camera's retained
image, because a real frame from before the camera was switched off would misrepresent what it is doing now.
Nothing is latched for it — the image is the intended presentation, and live view already reports why a
disabled camera cannot be watched. An absent or malformed observation is not a disabled one and falls through
to the normal order, for the same reason the live gate fails open.

When no admitted acquisition can answer a request at all, the plugin serves a packaged image rather than
failing it, because a HomeKit tile that cannot be drawn tells a viewer nothing while an explicit
"unavailable" frame does. The image ships as a baseline JPEG at the largest resolution HomeKit asks for and
is served as-is for every requested size, so this path needs no encoder and cannot fail for want of one; a
controller scales what it is given, and the delegate already ignores requested dimensions for real camera
stills. A substitution latches one bounded condition and a later real image withdraws it, so a camera that
only ever shows the placeholder is visible in the log instead of only on the tile. A package whose image is
missing or not a bounded JPEG leaves the request failing rather than serving bytes a controller cannot
decode, and a placeholder is never retained as a last successful image.

### Live view for a disabled camera

A camera that is turned off has no video to give, so live admission consults the camera's own enablement
observation. `SetupEndpoints` is the only refusal point HAP offers, so a refusal happens there, before any
port, SDK handle, or adaptation process exists, and it carries HAP's single `ERROR` status: the Home app
shows a generic streaming failure and the explanation is a plugin condition rather than a protocol field.
The stream management `Active` characteristic stays true throughout, because `hap-nodejs` treats it as
"this stream management is usable" and short-circuits snapshots and streams before the delegate is
consulted; setting it false would make presentation for a disabled camera unreachable, and the snapshot
path is deliberately not gated for the same reason.

Enablement is the only observation available for this. The SDK exposes privacy mode as a write with no
readback — nothing reports it back — and the privacy wire is not aliased into enablement, so a camera in
privacy mode is not distinguishable here. That gap is
[eufy-sdk#48](https://github.com/mega-yfue/eufy-sdk/issues/48). Enablement itself is a value the SDK now
states it stands behind on every family it supports, because it writes the param it reads on all of them
rather than diverting some to the privacy envelope
([eufy-sdk#79](https://github.com/mega-yfue/eufy-sdk/pull/79)); this plugin consumes that statement rather
than restating it, and declines any member the SDK withdraws it for.

A camera whose manifest omits the observation, reports it as something other than a boolean read, or
faults while reading it is treated as unobserved and streams exactly as it would without the gate:
refusing on an absent observation would withdraw live view from a working camera, which is the worse
failure of the two. A member the SDK names in its unreflected-members statement is declined for the same
reason: there the value is readable but does not track the write it accepts, and a reading that can silently
disagree with the device must neither refuse live view nor publish a camera as switched off. Declining means
the same thing everywhere — the gate does not refuse and nothing is published — because a value too
untrustworthy to publish is also too untrustworthy to withdraw a camera on. No capability module in the
pinned SDK declares the flag that produces that statement, so nothing is declined today, and a family whose
read stopped tracking its write would be declined the moment the SDK said so.

HomeKit is deliberately **not** told, only refused, and that reversal is the most expensive lesson this
feature taught. HAP's `ManuallyDisabled` states that a camera was disabled out of band, and Apple Home acts on
it: measured on a real home, a camera reporting it had every per-mode write silently dropped, while the same
phone, in the same minute, wrote another camera's mode and this camera's status light successfully. Both paired
controllers held admin permission, so the writes were declined by the controller, not by HAP.

That makes the state a trap rather than a description. Publishing it costs the ability to write that camera's
operating mode at all, so it must never be published for an off-state HomeKit can still fix — and the one case
it was published for is a write that failed, which is exactly when HomeKit needs to keep retrying. Not
publishing it leaves the home hub re-asserting its per-mode setting on every mode change and every
reconnection, so a failure heals itself; publishing it stops those re-assertions and makes the failure
permanent. Weighed against a cosmetic gain — a tile that reads "off" instead of one that fails — the trade was
never close, and four separate races reached the bad state during one afternoon of live testing before the
conclusion was drawn.

So the camera's own power is not published as HomeKit state at all, and an accessory restored from a version
that did has the characteristic withdrawn, along with the record that version kept for it. What replaces it is
actionable rather than decorative: the Camera Enabled switch reports the power and accepts writes, and Apple
Home was measured delivering writes to it on the very accessory whose operating mode it refused. A session a
disabled camera cannot serve is still refused by its own gate under a named reason, so nothing about the
refusal changed.

The operating mode service is therefore attached only where this bundle has something to put on it — the
indicator LED, night vision, or a camera-active state it can carry to the device. Exactly one such service may
exist on an accessory: a camera configured for HomeKit Secure Video already carries one that the HAP recording
controller owns, and HAP documents attaching an optional characteristic to it rather than adding a second
service, while a camera with no recording carries none and this plugin adds it under its own stable key. The
two cannot coexist, because HAP identifies a service by type and subtype and the controller's own carries an
empty subtype: a plugin-owned service surviving from a run without recording makes the controller's own throw
on attach, so it is withdrawn before the controller is configured.

HomeKit decides whether a camera is on, and this plugin carries that decision to the device. A per-mode value
reaches a camera that disagrees with it whether or not HomeKit's own value moved, because the alternative left
a divergence no action in the Home app could resolve: the only value a user can write is the one HomeKit
already holds, so a camera that was on while HomeKit held off stayed on for good. Reconciliation needs no
write of this plugin's own, because the home hub re-asserts its setting when the bridge reappears — that
re-assertion is now applied instead of discarded, which is also what makes a restart converge the device onto
the state the user chose.

A camera-active state this plugin cannot carry is still accepted rather than refused, because refusing would
leave the user unable to set the camera off in HomeKit at all; the write is simply HomeKit's own then. A write
the camera refuses reverts the state to what the camera reports, so HomeKit never keeps a claim the device did
not reach, and the characteristic answers reads: HAP throws the status a failed write left on a characteristic
that registers no read handler, on every later read and for good, so one refused power write reported a camera
as unresponsive until the bridge was restarted — observed on a real home.

Mid-session the plugin still re-reads the observation while a session is active, as the backstop for a
change no announcement reached. Re-reading is cheap — the read is served from memory and its own freshness
policy, not the tick, bounds how often it reaches the network — and it is armed only while a session exists,
so an idle camera is never polled. When the observation says disabled, HomeKit is told the session ended,
because a force-stop does not reach the delegate, and the same single release path stops adaptation and the
SDK consumer.

A session the camera did accept and then answered with audio and never a video frame is reported as that
camera being off rather than as a transport failure, when its observation says it is off. That is the case
where a reading taken before the session could have been stale, and the SDK's own `audio-only` start stage
is the corroboration: measured directly against a switched-off camera, the source accepted the start,
delivered 313 audio frames and no video frame across the whole warm-up window, and reported
`warm-timeout` at `audio-only` after ten attempts. The attribution is held by contract rather than by a live
run, because the plugin observes the camera as disabled within about five seconds of the change while the
SDK's warm-up deadline is twenty, so the race that produces it is not reachable on demand.

The freshness this rests on is now measured rather than assumed, and it changed: a write is acknowledged
before it converges, the reading follows within about half a second, and the SDK emits its change event once
per landed write ([eufy-sdk#79](https://github.com/mega-yfue/eufy-sdk/pull/79)). End to end on a wired
camera, with the switch thrown by a second SDK client: the streaming session ended 12.6 s after the power-off
was acknowledged, the accessory presented the camera as disabled 17.7 s after it, a later setup was refused
with HAP's `ERROR` status while snapshots stayed reachable, and a session was admitted again 11.6 s after
power-on with the presented state following. The mid-session half was formerly gated on
[eufy-sdk#47](https://github.com/mega-yfue/eufy-sdk/issues/47) and its qualification,
[#1043](https://github.com/homebridge-plugins/homebridge-eufy-security/issues/1043), now passes end to end.
What no controller can observe is what Apple Home renders from the presented state, which stays a human
check.

Which of the two mechanisms ends that session is now read off the run rather than inferred from the delay.
A write issued by another client cannot reach this plugin as the write confirmation, so the supervision read
looked like the only candidate — but the SDK announces a change on any inbound path it applies, including the
read-through re-read, and two later qualifications measured that announcement arriving on both camera bundles
and ending the session 10.6 s and 10.7 s after the acknowledged write, with the stream management service back
to available and no adaptation process, `disabled-mid-session` recorded exactly once and no session failure
beside it, presentation at 15.6 s, and readmission 16.5 s after power-on. The supervision read is therefore
the backstop rather than the mechanism. The delay belongs to the SDK's freshness window rather than to either:
a third run minutes apart ended at 5.5 s, all of them inside one window. Two upstream changes are required
together, and naming only the first credits the wrong one — the device-list fallback in
[eufy-sdk#47](https://github.com/mega-yfue/eufy-sdk/issues/47), without which the re-read landed the same
value forever, and the generic property announcement the same re-read now emits, without which a landed value
still had to be waited for. The distinction is worth measuring because both paths satisfy the gate and produce
the same delay, so a run reporting only the delay credits whichever one the reader already believed.

One reading is still acted on directly, deliberately. The upstream advice is not to treat a single stale
reading as authority for withdrawing a camera, and the reading can lag: a write made elsewhere is confirmed
through a cloud read measured at up to about six seconds behind. No second read or debounce is required
before acting, because what acting costs is bounded — the camera is presented as off and a session is
refused, both reversed by the next reading, and no accessory, service, or capability evidence is withdrawn —
while requiring corroboration would delay every real switch-off by a whole supervision period. The
corroboration the SDK does offer, its `audio-only` start stage, is used where it exists: to name the reason,
after a session the camera answered without video.

### One owner for a HomeKit-initiated device operation

Two camera bundles now write device state, so the bounded discipline that write needs lives once in
`homekit/device-control.ts` rather than twice: one operation in flight per member, a deadline that answers
HomeKit without cancelling a device that may be asleep, an operation the camera reports unsupported latched so
it is asked once, restoration from the authoritative reading rather than from what HomeKit asked for, and the
fail-closed observation read both bundles answer from. It is a seam for one contract, not a bucket: the policy
of every control stays in the adapter that owns the control.

### The camera operating mode service

One accessory carries exactly one Camera Operating Mode service, and the bundle that owns the camera
controller owns everything on it. That is not a preference: HomeKit Secure Video creates the service, HAP
identifies a service by type and subtype, and the controller's own carries an empty subtype — so a bundle
attaching to it before the controller exists creates a competing service that the controller then fails to
attach over. Adapter attachment order decides who runs first, and nothing about a service's meaning should
depend on that, so the streaming bundle publishes every state on it and the controls bundle publishes none.

Four states are published, each from evidence the SDK gives:

- **Manually disabled**, from the camera's enablement observation, so a camera that is off is presented as
  off rather than offered as a tile whose stream would be refused.
- **The operating mode indicator**, from the camera's status-light member. HomeKit calls this the camera
  operating mode indicator and the Home app shows it as the camera's status light, which is where it belongs;
  the switch an earlier version published for it is withdrawn by the bundle that published it. Measured on a
  real fleet: all eight cameras report that state as a writable boolean.
- **Night vision**, from the camera's night-vision mode. HomeKit carries one boolean and the SDK reports three
  modes, so the projection is this plugin's: every mode but off reads as on, and turning it back on restores
  the mode this camera last reported for itself. Infrared is the fallback where no lit mode was ever observed,
  because the SDK states some models omit full colour and writing colour blindly would ask a camera for
  something it may refuse — while writing infrared blindly would silently downgrade a camera whose owner had
  chosen colour. Measured on the same fleet: five of eight cameras report a mode, and the other three publish
  no night vision at all although all eight offer the setter. An installed setter is not evidence of a
  readable state.
- **HomeKit's own camera-active state**, which is HomeKit's rather than the camera's, and is carried through
  to the camera's power — see below.

Two more are seeded and deliberately not driven: the event and periodic snapshot states are HomeKit's own
policy about what it may ask for, and no SDK member corresponds to them. Two are refused outright: a
third-party-active state and a diagonal field of view have no SDK evidence behind them, and publishing either
would mean inventing a device fact.

The indicator and night vision are **timed-write** characteristics. A controller that writes them without
first preparing the write is answered `-70410` by HAP itself, before this plugin is consulted
(`Accessory.ts`), which is what a test controller sees and what iOS never does, because iOS prepares timed
writes natively. Their write paths are therefore held by contract rather than by a live controller run; their
published state is verified live.

### Turning the camera off because HomeKit says so

HomeKit's camera-active state is written by the Home app when a camera is set to off for the mode the home is
in. Where HomeKit Secure Video created the operating mode service, HAP gates streams, snapshots and recordings
on that state by itself; on a service this plugin publishes instead, HAP gates nothing and the state is
carried only here. Either way this plugin carries it through to the camera's power, deliberately: a camera the user has told HomeKit not to use is one they have asked not
to be watched by, and leaving it powered means it keeps recording to the vendor's cloud regardless.

Three rules bound that, because it is the only place where HomeKit writes a physical device state here:

- **The device is written only where a controller wrote the state and the camera disagrees with it.** HAP
  restores its own persisted copy with an update rather than a write, so that path never reaches a set handler
  at all. A value a controller merely re-asserts is deliberately applied, though: HomeKit decides whether the
  camera is on, and the home hub re-asserting its per-mode setting when the bridge reappears is what reconciles
  the device after a restart. Requiring the value to have moved was tried and withdrawn, because it left a
  divergence no action in the Home app could resolve — the only value a user can write is the one HomeKit
  already holds, so a camera that was on while HomeKit held off stayed on for good. Requiring the camera to
  disagree still stops a command that cannot succeed from being reissued on every reconnection.
- **A camera whose power cannot be written still accepts the state.** Refusing the write would leave the user
  unable to turn the camera off in HomeKit at all; where the operation is unevidenced or unbound, the state is
  simply HomeKit's own.
- **A camera that refuses the change reverts it.** The write fails to the controller and the state is put back
  to what the camera reports, so HomeKit never keeps a claim the camera did not reach. A camera that _accepts_
  it keeps the state the user chose: an acknowledgement is delivery and not convergence, so re-reading the
  camera at that moment would answer with the old value and undo the setting. Convergence is presented through
  the disabled state instead, which the SDK's change event moves a few seconds later.
- **Nothing moves the state the other way.** A camera switched back on in the vendor app is presented as
  enabled again, but the HomeKit setting the user chose stays theirs to change: overruling it from a device
  change is the conflation this boundary exists to prevent, and it would mean a vendor-app tap silently
  re-enabled HomeKit recording.

Measured end to end on an isolated instance against a real account, with the write coming from a HomeKit
controller: the camera reported itself disabled 3.0 s after the state was written off and enabled again 5.0 s
after it was written on, and the power state was confirmed on the device independently of what HomeKit was
told. The presented disabled state followed through the SDK's own change event, which is the one path a write
this plugin issues does announce — measured five times in one run.

### Live adaptation input timeline

A live source hands over an elementary stream through a pipe, and a pipe carries no container timeline.
The only timeline available is when each access unit arrived, so that is the one adaptation uses. Asking
FFmpeg to generate presentation timestamps instead makes it interpolate them from a frame rate a bare
Annex-B stream never states: the whole session collapses onto one instant and the constant-rate output
then resolves the timestamp collision by discarding almost every frame it was given. Measured on a real
camera, 326 source access units produced two coded frames.

For the same reason nothing asks FFmpeg to discard or reinterpret what it has already read. The initial
analysis window is bounded to its minimum instead, because the caller declares the input format and the
analysis has nothing left to discover; that bound is what makes time to first output independent of the
source keyframe interval, and it is the only part of the window a plugin can shorten without losing media.

Audio keeps its own clock. An ADTS or A-law elementary stream states its rate, so its timeline is real
without help, and the SDK reports neither a sample rate nor a channel count because a station sends
neither. Only raw A-law has to be told the 16 kHz mono assumption every Eufy client applies; telling an
ADTS demuxer the same thing fails the process before it reads a byte. That two-clock arrangement is
correct per stream and wrong across them when a source hands over a prebuffer in one burst: see
[#1046](https://github.com/homebridge-plugins/homebridge-eufy-security/issues/1046).

### Live adaptation delivery

An input option that costs media does not announce itself: the session still starts, still reports progress,
and still produces a coded stream, just a much later and much shorter one. The rule that catches it is
therefore stated over the access unit count rather than over the argument list, and it is split across the
two places that can hold each half of it.

The hermetic contract holds the half that needs no encoder. No adapted input — video of either codec, ADTS
audio, or raw A-law — may carry an option that discards what it analysed or fabricates a timeline, and every
one bounds its analysis window; and every access unit a session accepts reaches the process that codes it,
byte for byte and in order. Access units between a source geometry change and the keyframe a replacement
process can start from are the only ones a session may withhold, because no running process can code them.

The other half needs a real encoder, so `scripts/live-adaptation-delivery-check.mjs` measures it. It is an
accounting identity rather than an equality: the negotiated output is constant rate, so a source delivering
at another rate is legitimately duplicated or thinned to reach it, and what may never happen is a fed access
unit that is none of coded, duplicated from, or thinned. Raw equality would only hold when the source rate
already matches the negotiated one, which no camera guarantees.

### Live adaptation encoder

Live adaptation always encodes with `libx264` at `-preset superfast -tune zerolatency`. Hardware
encoding is excluded rather than deferred.

The negotiated contract requires the coded stream to carry exactly the negotiated profile, level,
geometry and frame rate and to stay under the negotiated bit rate. Constrained Baseline is the named
realization of a negotiated Baseline selection: it is a strict subset that any Baseline decoder accepts,
and the only Baseline form the encoder can produce. `superfast` is the cheapest preset that retains
CABAC and therefore the cheapest one that can satisfy a Main or High selection; `ultrafast` cannot,
because dropping CABAC forces the coded stream below the negotiated profile.

AAC-ELD output requires an explicit global header. `libfdk_aac` picks its transport from the framing the
output asks for and defaults to ADTS, which cannot carry AAC-ELD at all, so without that header the
encoder refuses to initialize and the negotiated audio codec is unreachable.

### The negotiated bit-rate ceiling

The negotiated bit rate bounds what the accessory **transmits**, not what it codes. RTP and SRTP overhead
fits inside the ceiling rather than beside it, because that is the traffic a metered or congested uplink
pays for and the figure a controller may size its own buffering against. Every other member of the
negotiated video parameters describes the coded picture, so this is a decision rather than a reading of the
parameter set, and it is recorded here because the rate-control arguments follow from it.

The ceiling is enforced over half a minute or more, which is where a VBV buffer's allowance has amortized
away. A hard cap over any window is not reachable: a one-second window carrying an instantaneous refresh
measured about 30 percent over on every rate-control setting tried, the tightest included, so a rule claiming
one would be describing H.264 rather than this plugin.

No threshold for a shorter window survived measurement either. Two cameras of one model, at one geometry and
one frame rate, carried 313 and 366 kbps against a 299 kbps ceiling over their worst ten-second window. That
spread is scene complexity rather than a property of the plugin: `-tune zerolatency` forces `rc_lookahead=0`,
and a ten-second window at 25 fps holds roughly four instantaneous refreshes, which an encoder without
lookahead cannot smooth. The worst ten-second window is therefore measured and reported on every live run, so
a regression is visible and comparable between revisions, but it is not a pass condition; a threshold fitted
to one fleet's scenes would fail the next, and a rule that fails intermittently teaches a maintainer to
ignore it. Reducing the refreshes rather than the allowance is the lever, and it is a separate decision about
the live keyframe interval.

Two arguments follow. The encoder is given the ceiling **less the RTP and SRTP bytes the session's own
packetization will add**, derived rather than chosen: a 12-byte RTP header and a 10-byte authentication tag
on every packet, and one packet per negotiated MTU of coded media plus one partial packet per frame. The
negotiated frame rate is the figure used, because it bounds packets per second exactly as it bounds
pictures per second; a camera delivering below its selection produces fewer packets than were reserved for,
which spends the ceiling rather than exceeding it. And the VBV buffer holds one second of that budget
rather than two, because a two-second buffer puts a 45-second window 4.4 percent over on arithmetic alone.

The measurement that fixed this is a back-to-back comparison, both phases inside one downtime window against
one storage copy, driven at each camera's own advertised geometry so the plugin build was the only variable.
Before the reservation, every camera coded an elementary stream inside its 299 kbps ceiling and still
transmitted 2.3 to 4.0 percent more than it had negotiated. After it, every camera transmitted under, at 276,
282, 289, 292 and 295 kbps. The overshoot was the transport, and the transport had never been reserved for.
Measured packetization overhead ran from 2.1 to 2.6 percent at frame rates of 15 and 25.

The margin is deliberately thin rather than generous. The cameras delivering 25 fps land closest to the
ceiling because packets per second scale with frames and those sessions spend most of what was reserved. A
session delivering the full negotiated 30 fps spends almost exactly the reservation, which is the point: the
derivation reserves what a full-rate session costs and no more.

Cost was measured rather than assumed: halving the buffer costs 0.12 of a quantizer step on the bundled
encoder, and capped CRF was rejected outright because it held the same rate at a quantizer of 49 against 34.

The recording path shares the buffer rule and not the reservation. A recording is carried as fragmented MP4
over the HAP session rather than as RTP, so it has neither those packets nor a measurement of what its own
container costs; reserving for a container overhead nobody has measured would be a guess.

### Return audio adaptation

Controller-to-accessory audio shares the live session's negotiated audio endpoint but not its outbound
adaptation. When exact SDK talkback evidence is present and camera audio is enabled, HomeKit is offered
16 kHz mono AAC-ELD return audio. The prepared media session hands its reserved audio UDP port to one
isolated FFmpeg process at start; FFmpeg authenticates and decrypts HomeKit SRTP, depacketizes the RFC 3640
AAC-hbr stream, decodes AAC-ELD, and emits 16 kHz mono AAC-LC ADTS at 32 kbit/s.

The SDK owns the ADTS byte stream after that boundary. It recovers complete frames across arbitrary FFmpeg
stdout chunks, rejects any frame that is not AAC-LC/16-kHz/mono or exceeds 640 bytes, and paces accepted
1024-sample frames at 64 ms. The plugin opens exactly one SDK talkback handle lazily, on the first decoded
return-audio bytes, so a live view whose controller never speaks holds no talkback handle and contributes
no talkback-owned budget extension. Once opened, budget notices are extended only until that handle fails,
stops, or the HomeKit session ends; a handle that resolves after cancellation is stopped without receiving
media.

Return audio has its own failure boundary. SRTP adaptation failure, SDK acquisition failure, and device
audio failure stop only the return process and talkback handle, latch one bounded `camera-talkback-failed`
condition, and leave outbound video, outbound audio, their SDK consumer, and the HomeKit session running.
A later talkback lifecycle that starts producing audio withdraws the condition. The camera-controls adapter
continues to own the one SDK-backed Speaker service; the camera controller stays in legacy service mode so
return audio does not create a duplicate speaker or microphone service.

### Recorded fragment adaptation

A HomeKit Secure Video recording is adapted from the SDK's fragment recording, not from the live
elementary streams. That input is a container with its own timeline, which is what makes a fragment's
duration and a track's alignment meaningful, and it is the only input a pre-event window can ever be
drained into. Nothing therefore generates or overrides timestamps on the way in, which is the opposite of
the live path and for the same underlying reason: adaptation uses the best timeline its input actually
carries.

The SDK's own fragments are Eufy source truth and cannot be passed through: they carry the camera's codec,
profile, level, geometry, frame rate and keyframe cadence unchanged, so no negotiated recording contract can
be satisfied without recoding.

Fragmentation is driven only by keyframes. A HomeKit fragment must open on one and must not be longer than
the selected fragment length, and a duration-driven cut is free to land between keyframes, so a
keyframe-driven cut is the only one that can satisfy both. The forced keyframe interval is therefore one
frame shorter than the governing bound, because a keyframe can only be coded on a frame the encoder
actually has: requesting one at the bound puts the boundary on the first frame at or after it and
measurably overruns the selected length. Keyframes slightly more often than selected remain inside a
selected maximum, so the shift costs nothing the contract protects. A source that codes slower than the
selected frame rate still quantizes the boundary to its own frame interval, so the residual bound is one
source frame rather than one negotiated frame, and live qualification measures that interval instead of
assuming it.

Source and output fragmentation are separate decisions. The length asked of the SDK's fragment recording
bounds only how long adapted output waits behind media the camera has already captured; the length HomeKit
selected is produced by the plugin's own refragmentation regardless. Asking the source for the selected
length therefore makes first output wait a whole output fragment behind media that already existed.
Measured on two wired cameras, asking for one second instead of the selected four brought first output from
13.2 s and 13.1 s down to 10.2 s and 10.7 s, with output fragments still spanning the selected four
seconds.

The station's level-2 grace belongs to the SDK session rather than to each fragment-recording request. A
first media call may spend that grace while the session negotiates, but a later recording joining an
already-warm source does not spend it again. Measured on a wired camera, the source handed over its first
fragment 18 ms after the recording request and the adapted initialization segment followed in 266 ms,
instead of the fixed roughly eight-second wait a per-call grace imposed. The plugin's own bound remains the
same backstop the live path uses, sitting strictly above the SDK's session and source windows.

Pre-event media is retained rather than warmed for, and its window belongs to whichever consumer opens the
shared source. A camera's source is opened with a four-second window only when the camera is mains powered
and admitted to HomeKit Secure Video, so nothing is ever streamed to fill a buffer: an unwatched camera
answers a recording from its trigger, and a battery or solar camera never retains a window at all, because
the only way its buffer would hold anything is a stream held open on its own power. The window is fixed when
the source is constructed, so live view asks for the same one a recording drains; asking for it only at
recording time on a source live view had already opened delivers nothing, which is why the policy lives with
the source rather than with the recording. Live view and live snapshots both ask for the same window because
either may be the call that opens the source. A drain opens on the newest retained keyframe at or before its
requested cutoff, so it covers the selected window when enough media exists and may exceed it by the distance
to that keyframe; a delivery stall keeps the complete decodable run rather than discarding its anchor.
Measured on one wired camera, a recording joining an already-warm source received at least 4.53 s of media
captured before it attached, every drained fragment opening on a keyframe.

A negotiated recording frame rate is a maximum rather than a target, so the output rate is bounded rather
than pinned. Pinning it makes the encoder duplicate frames a slower source never sent, and every duplicate
spends the negotiated bit rate on a frame that carries nothing. Measured on wired cameras that code near
15 fps against a selected 30, roughly half of a pinned output's frames were duplicates.

Finality needs one packet of lookahead, and takes it only where it is free. HomeKit is told a recording
ended by a flag on its last packet, and nothing can know a fragment is last until no more will arrive.
While the source is still delivering, fragments are therefore emitted immediately and unflagged; once the
source has ended and the adaptation's input is closed, the remaining fragments are held until the
adaptation exits and the final one is flagged. The common case, where the controller closes the stream
first, pays no latency at all.

Recording audio is withheld rather than substituted. HomeKit's own recording-audio state starts off, a
camera's audio can be turned off by preference, a controller can select a codec the camera never
advertised, and a source can carry no audio track at all. In every one of those cases the output carries
no audio track, because a recording without audio is playable and a recording with a substituted codec is
a claim the contract did not make.

### Reconfigured selection lifetime

A reconfigured selection is applied at the next source keyframe, and the adaptation carrying the previous
selection keeps running until then. A controller reconfigures a session precisely when it is unhappy with
what it is receiving, so the source is frequently the very thing not producing keyframes; ending the only
adaptation that is still producing output would replace a degraded picture with none at all.

The deferral is bounded by the same start backstop a session begins with, because a session that never
applies the selection HomeKit asked for has to end and be renegotiated rather than serve the old one
indefinitely. Only the adaptation carrying the current selection can discharge that bound: FFmpeg reports
progress on a timer whether or not new media reaches it, so a superseded process would otherwise clear a
deadline it can no longer satisfy.

A changed source codec or geometry is different in kind. The running process cannot code those frames at
all, so they are withheld until a keyframe lets a replacement start, and the negotiated output identity is
unchanged across that swap.

HomeKit advertises profiles, levels and resolutions as independent lists, so a controller may select a
level whose own frame-size limit the selected geometry exceeds. `libx264` writes the requested level
literally in that case, measured on the wire for all nine advertised profile and level combinations at
`1280x720@30` and again at `1920x1080@30`. Exact coded fidelity therefore holds for every advertised
profile and level, and whether a profile, level and resolution triple is itself conformant is a property
of the advertised matrix rather than of adaptation. A real Apple Home session selected High profile at
level 4.0 for `1280x720@30`, then reconfigured to `640x360@30` at the same level; it supplied no evidence
that Apple Home chooses an under-levelled triple. The plugin therefore preserves both the established
advertisement and exact coded fidelity rather than changing either without controller evidence. Every
start and reconfiguration records its identity-free profile, level, geometry and frame rate as the
allowlisted `live-video-selected` debug trace so future real-controller evidence can revisit that decision.

No hardware encoder reachable on a Homebridge host clears that bar. The encoders present in every
bundled Linux artifact cannot express the advertised profile set at all, and the encoders that can
express it are absent from every bundled artifact. Availability is also not qualification: an encoder
that enumerates may still fail at option parse, fail at device open, or silently widen the coded
profile, and each stage must be proven separately. V4 shipped that mistake — a probe that validated a
smaller command than the one it authorized — and every session on the affected hosts failed while the
probe reported success.

Encoding cost is not what the exclusion trades away. On a Homebridge host with the bundled binary,
retaining CABAC costs half a percent of encoder CPU and halves the quantizer at the same bit-rate
ceiling. Revisit this decision only when both conditions hold: a bundled artifact ships an encoder that
expresses every advertised combination exactly, and a measurement on a real constrained host shows
software encoding cannot serve the advertised concurrent-session count. The supporting evidence is in
[hardware encoder viability](./reference/hardware-encoder-viability.md).

### Concurrent media capacity

Concurrent media capacity is declared by whoever runs the host, and unlimited until they declare it. The
plugin neither infers a capacity nor measures one.

Inferring it is not available. A core count overstates capacity by whatever share of the host the plugin
does not have: measured on a containerised eight-core host, the readable quota was 2.5 cores, so
`os.cpus().length` overstated it by a factor of 3.2. A container quota is not a substitute, because on a
host without one the cgroup file does not exist at all. Neither input is usable, so neither is read.

Measuring it was considered and rejected. Each live adaptation already reports coded frames on a timer, so
a throughput estimator is buildable, but a session coding below its negotiated rate does not identify its
own cause: a saturated host, a stalled SDK source, a source held by backpressure, and a camera delivering
below the negotiated rate all read the same way. Refusing a session for a cause the signal cannot
establish presents as a broken camera, which is a worse and more visible defect than the degraded picture
it would prevent. Backpressure already bounds what an overloaded host can damage, so what remains at stake
is picture quality rather than plugin liveness.

A declared limit carries no such ambiguity, because it states an intent rather than estimating a fact. One
limit covers live sessions and live snapshot acquisitions together: each is one SDK pull and at least one
adaptation process, and a still on an idle camera is routinely the call that opens the pull, so counting
them apart would leave the operator summing two numbers to predict what the host carries. Work whose cost
is already admitted elsewhere is not counted twice — a snapshot request that joins an acquisition already
in flight, and a still taken from a source a live session is holding open, both ride the share that was
already granted.

The limit is applied at admission only. An established session is never ended to make room, because the
accessory cannot renegotiate a selection and ending one is indistinguishable from a failure to whoever is
watching it. A refused live session reports one bounded reason of its own, kept apart from the enablement
refusal because the two are withdrawn by different events and name different things to do about them, and
opens no port, handle, or process. A refused snapshot falls back to the camera's retained image, so a
bounded host answers a camera list with real if older pictures rather than nothing, and a refused
background refresh spends no part of its refresh window, since a refusal is not a refresh. Capacity
therefore recovers as sessions end, with no restart and no reconciliation.

The background live refresh of a `Refresh` camera is spread rather than run on a shared clock. Every camera
answers its first request from its retained image and starts one refresh behind it, so a controller that
asks about every camera at once leaves them all falling due at the same instant; a fixed interval would
keep them there for as long as the plugin runs. Each camera therefore draws its own next due time, up to
half an interval later, and commits it when the refresh starts. Deriving it per request instead would take
the shortest of many draws and return the busiest cameras to the shared clock.

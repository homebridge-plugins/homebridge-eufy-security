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
readback — nothing reports it back — and on the camera families whose power rides the privacy envelope the
privacy wire is not aliased into enablement either, so a camera in privacy mode is not distinguishable here,
and on those families a camera that has been switched off may not be either. That gap is
[eufy-sdk#48](https://github.com/mega-yfue/eufy-sdk/issues/48).

A camera whose manifest omits the observation, reports it as something other than a boolean read, or
faults while reading it is treated as unobserved and streams exactly as it would without the gate:
refusing on an absent observation would withdraw live view from a working camera, which is the worse
failure of the two.

Mid-session the plugin re-reads that observation while a session is active, rather than waiting for an
event, because no event exists: the camera capability declares none, the property-change list the SDK
computes when it applies params is discarded by every caller, and the registry republishes only when a
device is added, removed, or gains a capability. Re-reading is cheap — the read is served from memory and
its own freshness policy, not the tick, bounds how often it reaches the network — and it is armed only
while a session exists, so an idle camera is never polled. When the observation says disabled, HomeKit is
told the session ended, because a force-stop does not reach the delegate, and the same single release path
stops adaptation and the SDK consumer.

What that mechanism cannot do is invent the observation's freshness. Measured on a wired camera: turning
it off is visible to a newly constructed SDK client about thirty seconds later and to a restarted plugin
immediately, but a long-lived client's read-through refresh never updated the value at all — the plugin
still read the camera as enabled after four minutes and many reads. So a session already streaming when
the camera is switched off ends today only if the device volunteers the parameter over its realtime wire.
The refusal path, which reads the observation as it stood when the registry was built, is unaffected and is
proven on the wire. The remaining half is an SDK observation gap rather than a policy question, tracked
upstream as [eufy-sdk#47](https://github.com/mega-yfue/eufy-sdk/issues/47) and qualified here by
[#1043](https://github.com/homebridge-plugins/homebridge-eufy-security/issues/1043), which is gated on it.

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

Host capacity for concurrent adaptation is observed, never inferred. A core count is not a capacity and
a container quota is not always readable, so the plugin admits sessions against the throughput its own
running adaptations report and refuses a new session while an active one cannot hold real time. It never
ends an established session to make room, because the accessory cannot renegotiate a selection and
ending one is indistinguishable from a failure to the viewer.

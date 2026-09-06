# V5 Device Mapping Context

This context translates verified SDK device truth into HomeKit representation. It distinguishes device semantics from HomeKit policy so that mappings remain explicit where meaning cannot be inferred from value shape alone.

## Device Truth

**Capability**:
A semantically meaningful device feature reported by the SDK.
_Avoid_: Feature flag, service, device profile

**Member**:
An evidence-gated readable value, event, or operation belonging to a capability.
_Avoid_: Property, characteristic

**Observation**:
Truth reported by the device through the SDK.
_Avoid_: Current value, desired state

**Persistent write**:
An operation intended to establish a durable device state, such as an arming mode.
_Avoid_: Setter, action

**Momentary action**:
An operation intended to cause an effect without establishing durable device state, such as triggering a siren.
_Avoid_: Setter, state change

## HomeKit Mapping

**Capability adapter**:
An explicit plugin mapping from one capability to HomeKit representation; it may create several services or characteristics.
_Avoid_: Generic mapper, automatic mapper

**Bundle adapter**:
An explicit adapter that coordinates multiple capabilities or multiple HomeKit services whose behavior is coupled.
_Avoid_: Generic bundle, implicit grouping

**Projection**:
The plugin's optimistic requested value while a persistent write is awaiting device reconciliation. HomeKit may present this projection as `current` by policy, but it is not an observation.
_Avoid_: Device state, confirmed current

**Reconciliation window**:
The bounded period after a persistent write is acknowledged during which its projection awaits a matching authoritative observation. Expiry removes the projection without changing the last observation.
_Avoid_: Command timeout, retry window

**Adapter fault**:
An active, recoverable condition in which an adapter cannot truthfully serve its HomeKit contract from current SDK evidence. A later authoritative observation may clear it.
_Avoid_: Device state, unsupported capability

**Diagnostic condition**:
An allowlisted, structured account of an adapter anomaly that is emitted on condition transitions and explicitly cleared on recovery.
_Avoid_: Log message, raw error

**Capability withdrawal**:
The omission of a previously admitted capability member from a complete authoritative device snapshot. Partial realtime reports and connection loss cannot establish withdrawal.
_Avoid_: Missing report, temporary capability loss

**Diagnostic**:
Structured information about unsupported mappings, unknown capabilities, or reconciliation anomalies.
_Avoid_: Error service, fallback capability

**Recognized device**:
A device whose identity and capabilities are known to the SDK, whether or not HomeKit can represent them.
_Avoid_: Supported device

**Represented device**:
A recognized device with at least one primary-purpose member mapped to a semantically matching official HomeKit service, characteristic, or controller. Secondary members such as battery or identity information supplement representation but do not establish it.
_Avoid_: Recognized device, supported device

**Primary-purpose member**:
A capability member that expresses the physical device's principal user-facing purpose, such as sensing contact, controlling a light, or streaming camera media.
_Avoid_: Any mapped member, accessory metadata

**Controllable device**:
A represented device with at least one verified operation available through HomeKit.
_Avoid_: Represented device, supported device

**Accessory container**:
The stable, SDK-entity-serial-based HomeKit identity for a represented physical device, hosting the official services, characteristics, and controllers selected by its adapted capability members. Parent station, channel, transport endpoint, and discovery order are routing or reconciliation facts, not identity inputs.
_Avoid_: Device type, capability adapter

**Coverage row**:
The evaluation of one semantically distinct SDK capability member, classified as a read, event, persistent operation, or momentary action and linked to any coordinating bundle.
_Avoid_: Device mapping, model mapping

**SDK/HAP coverage matrix**:
A versioned set of coverage rows that records whether and how current SDK device truth has a semantically matching official HomeKit representation.
_Avoid_: Parity matrix, model allowlist

**SDK gap**:
Missing or withheld verified device truth, semantic metadata, operation behavior, classification, or transport behavior that the plugin must not infer or manufacture.
_Avoid_: Plugin workaround, unsupported HomeKit feature

**Compatibility workaround**:
Behavior that compensates for a limitation in a dependency or supported runtime rather than representing Eufy device truth or HomeKit policy.
_Avoid_: Capability adapter, device support

## Session Ownership

**SDK owner**:
The single process currently permitted to operate an SDK client and its persisted session for an account.
_Avoid_: Active client, shared client

**Runtime owner**:
The long-lived SDK owner that maintains realtime connectivity and the canonical device registry during normal plugin operation.
_Avoid_: Main client, backend client

**Temporary authentication owner**:
The short-lived UI SDK owner that performs an explicitly requested login or account replacement, including any captcha or two-factor continuation.
_Avoid_: UI client, secondary client

**Device snapshot**:
A versioned, allowlisted view of the latest complete device information published for configuration and diagnostics consumers.
_Avoid_: SDK cache, raw device dump

## Configuration

**Configuration-block identity**:
The V5-only `HomebridgeEufy` platform alias that lets Homebridge locate the plugin block. V5 does not register or accept the V4 `EufySecurity` alias and does not grant legacy settings, defaults, or behavior compatibility.
_Avoid_: V4 configuration identity, configuration backward compatibility

**Entity preference**:
A sparse plugin-owned representation or media preference keyed by the SDK entity serial and retained while that entity is absent from the current device snapshot.
_Avoid_: Device state, device metadata, ignore list

## Release

**Private pilot artifact**:
An immutable plugin build distributed directly to the authorized maintainer for V5 qualification without advancing a public npm user channel.
_Avoid_: Beta release, public prerelease

**Release canary**:
A disposable prerelease published on a non-user npm channel solely to prove publication identity, provenance, and installation mechanics before or after an administrative release-system change.
_Avoid_: Private pilot, beta promotion

**Rollback baseline**:
The restorable pre-pilot Homebridge state together with the exact prior plugin version required to return to the previous release. It does not imply that the previous release can consume state written by V5.
_Avoid_: In-place downgrade, configuration migration

**Public beta promotion**:
The explicit decision to advance the npm beta channel from private V5 qualification to an anonymously installable release after its distribution and acceptance gates pass.
_Avoid_: Pilot completion, SDK publication, elapsed-time rollout

**Acceptance matrix**:
A versioned, cumulative record of automated and human checks whose passed results qualify one immutable artifact for an implementation, private-pilot, or public-beta acceptance tier.
_Avoid_: Test checklist, elapsed-time qualification, general confidence

**Fleet projection**:
An allowlisted, de-identified description of model, topology, and capability shapes derived from explicitly initiated observation-only fleet reads and used to inform synthetic verification fixtures.
_Avoid_: Fleet dump, live test dependency, redacted raw record

## Media

**Stored-only snapshot**:
A still image already observed through cloud or push input and retained by the SDK, returned without opening P2P, querying device or station storage, pre-warming, attaching a live source, or invoking media adaptation.
_Avoid_: Cloud refresh, stored P2P snapshot, live snapshot

**Last successful image**:
The plugin's restart-surviving fallback image for a camera, replaced only by a successfully validated stored-only or live snapshot and withheld while that camera is disabled.
_Avoid_: SDK snapshot cache, placeholder

**Snapshot placeholder**:
A plugin-owned predefined image returned to HomeKit when policy withholds camera imagery or no last successful image is available for the evidenced device state.
_Avoid_: Stored-only snapshot, last successful image, SDK error image

**Session pre-warm**:
Speculative establishment of device connectivity before a media consumer attaches. It does not start media or retain pre-event frames.
_Avoid_: Prebuffer, active stream

**Media prebuffer**:
Keyframe-aligned media retained before a recording trigger while a media source is already active.
_Avoid_: Session pre-warm, recording delay

**Recorded fragment**:
One complete `moof` and `mdat` pair of adapted recording output, opening on a sample a decoder can start
from and spanning no more than the fragment length a controller selected. The initialization segment that
precedes the first one is not a recorded fragment.
_Avoid_: Media prebuffer, source fragment, recording chunk

**Source fragment**:
One fragment the SDK's fragment recording emits, carrying the camera's own codec, profile, level,
geometry, and keyframe cadence. It is recording input, never HomeKit output.
_Avoid_: Recorded fragment, negotiated recording

**Advertised resolution matrix**:
The resolutions one camera offers a HomeKit controller, derived from the shape that camera's own frames have
rather than from a fixed list. A controller reads it when the accessory's structure changes and keeps that
copy, so a change to it reaches an accessory paired afterwards and not one paired before.
_Avoid_: Negotiated live selection, announced source configuration

**Announced source configuration**:
The codec and coded picture size the SDK states a live source is producing, read from the parameter sets in
force and announced once per change immediately before the first frame carrying it. It is what the source
is sending, never what HomeKit asked for; a camera changes it several times within one session, and only a
changed codec requires a new media adaptation.
_Avoid_: Negotiated recording, negotiated live selection, frame geometry

**Negotiated recording**:
The complete recording contract one HomeKit controller selected: container and fragment length, H.264
profile, level, geometry, frame-rate ceiling, bit-rate ceiling, keyframe interval, and audio codec.
Absent audio means the output carries no audio track, never a substituted one.
_Avoid_: Recording preset, supported recording configuration

**Media adaptation**:
Plugin-owned translation of SDK media source truth into a HomeKit-negotiated codec, framing, timing, and transport contract.
_Avoid_: Device decoding, SDK media transport

**Prepared live session**:
A live session whose endpoints are negotiated and whose output ports are reserved, holding no source,
adaptation process, or device session until it is started. Its lifetime belongs to the controller
connection that negotiated it, not to a plugin deadline.
_Avoid_: Session pre-warm, active stream, idle stream

**Adaptation host capability**:
A media facility supplied by the host installation rather than by the device or the plugin, such as the
encoders present in the resolved adaptation executable. It varies per installation, is neither device
truth nor HomeKit policy, and may not be relied on before qualification.
_Avoid_: SDK gap, compatibility workaround, supported capability

**Encoder qualification**:
Proof that a candidate adaptation encoder satisfies a negotiated contract, established in four
independent stages: the encoder is named by the executable, the exact argument list the session will use
is accepted, the encoder opens against the host's devices and drivers, and the coded output carries the
negotiated profile, level, geometry, timing, and bit-rate ceiling. Passing an earlier stage never
implies a later one.
_Avoid_: Probe, encoder detection, capability enumeration

**Qualified encoder**:
An adaptation encoder that has passed every stage of encoder qualification for the negotiated selection
it is used to serve. An unqualified encoder is not a fallback.
_Avoid_: Available encoder, detected encoder, hardware encoder

## Diagnostics

**Guided diagnostics session**:
An explicitly initiated, time-bounded troubleshooting flow that selects an evidence profile, correlates a reproduction, and verifies evidence completeness before export.
_Avoid_: Debug mode, telemetry

**Support archive**:
A user-exported, encrypted collection of allowlisted troubleshooting evidence and a manifest describing its contents, privacy classes, and any missing evidence.
_Avoid_: Log bundle, raw device dump

**Support case identifier**:
A random identifier scoped to one guided diagnostics session that correlates its logs, diagnostics, manifest, and issue report.
_Avoid_: Device identifier, account identifier

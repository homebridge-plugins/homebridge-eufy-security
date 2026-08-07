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

**Diagnostic**:
Structured information about unsupported mappings, unknown capabilities, or reconciliation anomalies.
_Avoid_: Error service, fallback capability
